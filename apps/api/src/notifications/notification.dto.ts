import { Type } from "class-transformer";
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  Min,
  ValidateNested,
} from "class-validator";

export class PushSubscriptionKeysDto {
  @IsString() @Length(20, 500) auth!: string;
  @IsString() @Length(40, 500) p256dh!: string;
}

export class CreatePushSubscriptionDto {
  @IsUrl({ protocols: ["https"], require_protocol: true })
  @Length(20, 2000)
  endpoint!: string;
  @IsOptional() @IsInt() @Min(0) expirationTime?: number | null;
  @ValidateNested() @Type(() => PushSubscriptionKeysDto) keys!: PushSubscriptionKeysDto;
}

export class UpdateNotificationPreferenceDto {
  @IsBoolean() normalPushEnabled!: boolean;
  @IsBoolean() pushEnabled!: boolean;
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) quietHoursEnd!: string;
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) quietHoursStart!: string;
  @IsInt() @Min(1) version!: number;
}
