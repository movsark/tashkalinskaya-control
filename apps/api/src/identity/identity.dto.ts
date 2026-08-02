import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsObject,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateNested,
} from "class-validator";

import { ROLE_CODES, SCOPE_TYPES, type EmploymentStatus } from "@tashkalinskaya/contracts";

export class RoleInputDto {
  @IsIn(ROLE_CODES)
  roleCode!: (typeof ROLE_CODES)[number];

  @IsIn(SCOPE_TYPES)
  scopeType!: (typeof SCOPE_TYPES)[number];

  @IsOptional()
  @IsUUID()
  scopeId?: string;
}

export class CreateEmployeeDto {
  @IsString()
  @Length(2, 200)
  fullName!: string;

  @IsString()
  @Length(1, 40)
  personnelNumber!: string;

  @IsString()
  @Length(1, 100)
  login!: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(9)
  @ValidateNested({ each: true })
  @Type(() => RoleInputDto)
  roles!: RoleInputDto[];
}

export class ActivateAccountDto {
  @IsString()
  @Length(1, 100)
  login!: string;

  @IsString()
  @Length(20, 100)
  activationCode!: string;

  @IsString()
  @Length(8, 128)
  password!: string;

  @IsString()
  @Length(1, 100)
  deviceLabel!: string;

  @IsIn(["ANDROID", "IOS", "IPADOS", "OTHER"])
  platformFamily!: "ANDROID" | "IOS" | "IPADOS" | "OTHER";

  @IsUUID()
  challengeId!: string;

  @IsObject()
  credential!: Record<string, unknown>;
}

export class ActivationOptionsDto {
  @IsString()
  @Length(1, 100)
  login!: string;

  @IsString()
  @Length(20, 100)
  activationCode!: string;
}

export class LoginOptionsDto {
  @IsString()
  @Length(1, 100)
  login!: string;

  @IsUUID()
  deviceId!: string;
}

export class LoginDto extends LoginOptionsDto {
  @IsString()
  @Length(1, 128)
  password!: string;

  @IsUUID()
  challengeId!: string;

  @IsObject()
  credential!: Record<string, unknown>;
}

export class AssertionDto {
  @IsUUID()
  challengeId!: string;

  @IsObject()
  credential!: Record<string, unknown>;
}

export class StepUpDto extends AssertionDto {
  @IsString()
  @Length(1, 128)
  password!: string;
}

export class IssueRecoveryDto {
  @IsString()
  @Length(3, 500)
  reason!: string;
}

export class RecoveryOptionsDto {
  @IsString()
  @Length(1, 100)
  login!: string;

  @IsString()
  @Length(20, 100)
  recoveryCode!: string;
}

export class RecoverAccountDto extends RecoveryOptionsDto {
  @IsString()
  @Length(8, 128)
  password!: string;

  @IsString()
  @Length(1, 100)
  deviceLabel!: string;

  @IsIn(["ANDROID", "IOS", "IPADOS", "OTHER"])
  platformFamily!: "ANDROID" | "IOS" | "IPADOS" | "OTHER";

  @IsUUID()
  challengeId!: string;

  @IsObject()
  credential!: Record<string, unknown>;
}

export class CreateTerminalDto {
  @IsString()
  @Length(1, 40)
  terminalCode!: string;

  @IsString()
  @Length(1, 100)
  locationLabel!: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;
}

export class TerminalPairingOptionsDto {
  @IsString()
  @Length(1, 40)
  terminalCode!: string;

  @IsString()
  @Length(20, 100)
  pairingCode!: string;
}

export class PairTerminalDto extends TerminalPairingOptionsDto {
  @IsUUID()
  challengeId!: string;

  @IsObject()
  credential!: Record<string, unknown>;
}

export class TerminalLoginOptionsDto {
  @IsString()
  @Length(1, 40)
  terminalCode!: string;
}

export class TerminalLoginDto extends TerminalLoginOptionsDto {
  @IsUUID()
  challengeId!: string;

  @IsObject()
  credential!: Record<string, unknown>;
}

export class UpdateEmployeeStatusDto {
  @IsIn(["ACTIVE", "SUSPENDED", "DISMISSED", "ARCHIVED"])
  status!: EmploymentStatus;

  @IsString()
  @Length(3, 500)
  reason!: string;

  @IsInt()
  @Min(1)
  version!: number;
}

export class ReplaceRolesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(9)
  @ValidateNested({ each: true })
  @Type(() => RoleInputDto)
  roles!: RoleInputDto[];

  @IsString()
  @Length(3, 500)
  reason!: string;

  @IsInt()
  @Min(1)
  version!: number;
}

export class RevokeDeviceDto {
  @IsString()
  @Length(3, 500)
  reason!: string;
}
