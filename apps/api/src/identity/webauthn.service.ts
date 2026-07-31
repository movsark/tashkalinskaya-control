import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

import { API_CONFIG, type ApiConfig } from "../config";
import {
  DeviceSecurityRepository,
  type ChallengePurpose,
  type FactoryTerminalDeviceRecord,
} from "./device-security.repository";
import { IdentityCryptoService } from "./identity-crypto.service";
import type { DeviceRecord } from "./identity.types";

export interface RegisteredCredential {
  readonly backedUp: boolean;
  readonly counter: number;
  readonly deviceType: "multiDevice" | "singleDevice";
  readonly id: string;
  readonly publicKey: Uint8Array;
  readonly transports: readonly string[];
}

@Injectable()
export class WebAuthnService {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly crypto: IdentityCryptoService,
    private readonly securityRepository: DeviceSecurityRepository,
  ) {}

  async registrationOptions(input: {
    accountId?: string;
    displayName: string;
    factoryTerminalId?: string;
    purpose: Extract<ChallengePurpose, "ACTIVATION" | "RECOVERY" | "TERMINAL_PAIRING">;
    userId: string;
    userName: string;
  }): Promise<{
    challengeId: string;
    options: PublicKeyCredentialCreationOptionsJSON;
  }> {
    const options = await generateRegistrationOptions({
      attestationType: "none",
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        residentKey: "required",
        userVerification: "required",
      },
      rpID: this.config.webauthnRpId,
      rpName: this.config.webauthnRpName,
      supportedAlgorithmIDs: [-7, -257],
      timeout: 5 * 60 * 1000,
      userDisplayName: input.displayName,
      userID: new TextEncoder().encode(input.userId),
      userName: input.userName,
    });
    const challengeId = await this.securityRepository.createChallenge({
      ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
      challengeHash: this.crypto.hashChallenge(options.challenge),
      ...(input.factoryTerminalId === undefined
        ? {}
        : { factoryTerminalId: input.factoryTerminalId }),
      purpose: input.purpose,
    });
    return { challengeId, options };
  }

  async verifyRegistration(input: {
    accountId?: string;
    challengeId: string;
    factoryTerminalId?: string;
    purpose: Extract<ChallengePurpose, "ACTIVATION" | "RECOVERY" | "TERMINAL_PAIRING">;
    response: RegistrationResponseJSON;
  }): Promise<RegisteredCredential> {
    const challenge = await this.securityRepository.getChallenge(input.challengeId, input.purpose);
    if (
      challenge.accountId !== (input.accountId ?? null) ||
      challenge.factoryTerminalId !== (input.factoryTerminalId ?? null)
    ) {
      await this.securityRepository.failChallenge(input.challengeId);
      throw authenticationFailed();
    }
    try {
      const verification = await verifyRegistrationResponse({
        expectedChallenge: (candidate) =>
          this.crypto.hashChallenge(candidate) === challenge.challengeHash,
        expectedOrigin: [...this.config.webauthnOrigins],
        expectedRPID: this.config.webauthnRpId,
        requireUserPresence: true,
        requireUserVerification: true,
        response: input.response,
        supportedAlgorithmIDs: [-7, -257],
      });
      if (!verification.verified) throw authenticationFailed();
      await this.securityRepository.consumeChallenge(challenge.id);
      return {
        backedUp: verification.registrationInfo.credentialBackedUp,
        counter: verification.registrationInfo.credential.counter,
        deviceType: verification.registrationInfo.credentialDeviceType,
        id: verification.registrationInfo.credential.id,
        publicKey: verification.registrationInfo.credential.publicKey,
        transports: verification.registrationInfo.credential.transports ?? [],
      };
    } catch (error) {
      await this.securityRepository.failChallenge(input.challengeId);
      if (error instanceof UnauthorizedException) throw error;
      throw authenticationFailed();
    }
  }

  async authenticationOptions(input: {
    accountId: string;
    device: DeviceRecord;
    purpose: Extract<ChallengePurpose, "LOGIN" | "REFRESH" | "STEP_UP">;
  }): Promise<{
    challengeId: string;
    options: PublicKeyCredentialRequestOptionsJSON;
  }> {
    if (input.device.webauthnCredentialId === null) throw authenticationFailed();
    const options = await generateAuthenticationOptions({
      allowCredentials: [
        {
          id: input.device.webauthnCredentialId,
          transports: input.device.webauthnTransports as AuthenticatorTransportFuture[],
        },
      ],
      rpID: this.config.webauthnRpId,
      timeout: 5 * 60 * 1000,
      userVerification: "required",
    });
    const challengeId = await this.securityRepository.createChallenge({
      accountId: input.accountId,
      challengeHash: this.crypto.hashChallenge(options.challenge),
      personalDeviceId: input.device.id,
      purpose: input.purpose,
    });
    return { challengeId, options };
  }

  async verifyAuthentication(input: {
    accountId: string;
    challengeId: string;
    device: DeviceRecord;
    purpose: Extract<ChallengePurpose, "LOGIN" | "REFRESH" | "STEP_UP">;
    response: AuthenticationResponseJSON;
  }): Promise<number> {
    const challenge = await this.securityRepository.getChallenge(input.challengeId, input.purpose);
    if (
      challenge.accountId !== input.accountId ||
      challenge.personalDeviceId !== input.device.id ||
      input.device.webauthnCredentialId === null ||
      input.device.webauthnPublicKey === null ||
      input.response.id !== input.device.webauthnCredentialId
    ) {
      await this.securityRepository.failChallenge(input.challengeId);
      throw authenticationFailed();
    }
    try {
      const verification = await verifyAuthenticationResponse({
        credential: {
          counter: input.device.webauthnCounter,
          id: input.device.webauthnCredentialId,
          publicKey: new Uint8Array(input.device.webauthnPublicKey),
          transports: input.device.webauthnTransports as AuthenticatorTransportFuture[],
        },
        expectedChallenge: (candidate) =>
          this.crypto.hashChallenge(candidate) === challenge.challengeHash,
        expectedOrigin: [...this.config.webauthnOrigins],
        expectedRPID: this.config.webauthnRpId,
        requireUserVerification: true,
        response: input.response,
      });
      if (!verification.verified) throw authenticationFailed();
      await this.securityRepository.consumeChallenge(challenge.id);
      return verification.authenticationInfo.newCounter;
    } catch (error) {
      await this.securityRepository.failChallenge(input.challengeId);
      if (error instanceof UnauthorizedException) throw error;
      throw authenticationFailed();
    }
  }

  async terminalAuthenticationOptions(input: {
    purpose: "TERMINAL_LOGIN";
    terminal: FactoryTerminalDeviceRecord;
  }): Promise<{
    challengeId: string;
    options: PublicKeyCredentialRequestOptionsJSON;
  }> {
    if (input.terminal.webauthnCredentialId === null) throw authenticationFailed();
    const options = await generateAuthenticationOptions({
      allowCredentials: [
        {
          id: input.terminal.webauthnCredentialId,
          transports: input.terminal.webauthnTransports as AuthenticatorTransportFuture[],
        },
      ],
      rpID: this.config.webauthnRpId,
      timeout: 5 * 60 * 1000,
      userVerification: "required",
    });
    const challengeId = await this.securityRepository.createChallenge({
      challengeHash: this.crypto.hashChallenge(options.challenge),
      factoryTerminalId: input.terminal.id,
      purpose: input.purpose,
    });
    return { challengeId, options };
  }

  async verifyTerminalAuthentication(input: {
    challengeId: string;
    purpose: "TERMINAL_LOGIN";
    response: AuthenticationResponseJSON;
    terminal: FactoryTerminalDeviceRecord;
  }): Promise<number> {
    const challenge = await this.securityRepository.getChallenge(input.challengeId, input.purpose);
    if (
      challenge.accountId !== null ||
      challenge.personalDeviceId !== null ||
      challenge.factoryTerminalId !== input.terminal.id ||
      input.terminal.webauthnCredentialId === null ||
      input.terminal.webauthnPublicKey === null ||
      input.response.id !== input.terminal.webauthnCredentialId
    ) {
      await this.securityRepository.failChallenge(input.challengeId);
      throw authenticationFailed();
    }
    try {
      const verification = await verifyAuthenticationResponse({
        credential: {
          counter: input.terminal.webauthnCounter,
          id: input.terminal.webauthnCredentialId,
          publicKey: new Uint8Array(input.terminal.webauthnPublicKey),
          transports: input.terminal.webauthnTransports as AuthenticatorTransportFuture[],
        },
        expectedChallenge: (candidate) =>
          this.crypto.hashChallenge(candidate) === challenge.challengeHash,
        expectedOrigin: [...this.config.webauthnOrigins],
        expectedRPID: this.config.webauthnRpId,
        requireUserVerification: true,
        response: input.response,
      });
      if (!verification.verified) throw authenticationFailed();
      await this.securityRepository.consumeChallenge(challenge.id);
      return verification.authenticationInfo.newCounter;
    } catch (error) {
      await this.securityRepository.failChallenge(input.challengeId);
      if (error instanceof UnauthorizedException) throw error;
      throw authenticationFailed();
    }
  }
}

function authenticationFailed(): UnauthorizedException {
  return new UnauthorizedException({
    code: "AUTHENTICATION_FAILED",
    message: "Не удалось подтвердить устройство системным PIN или биометрией",
  });
}
