import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from "class-validator";

export class OpenLoadingGroupDto {
  @IsInt() @Min(1) version!: number;
  @IsString() @Length(8, 100) idempotencyKey!: string;
}

export class CreateLoadingLineDto {
  @IsUUID() productId!: string;
  @IsInt() @Min(1) @Max(100_000) quantity!: number;
  @IsInt() @Min(1) sessionVersion!: number;
  @IsString() @Length(8, 100) idempotencyKey!: string;
  @IsOptional() @IsString() @Length(3, 500) comment?: string;
}

export class ReviseLoadingLineDto {
  @IsInt() @Min(1) @Max(100_000) quantity!: number;
  @IsInt() @Min(1) version!: number;
  @IsString() @Length(8, 100) idempotencyKey!: string;
  @IsString() @Length(3, 500) comment!: string;
}

export class ReassignLoadingLineDto {
  @IsUUID() targetSessionId!: string;
  @IsInt() @Min(1) version!: number;
  @IsString() @Length(8, 100) idempotencyKey!: string;
  @IsString() @Length(3, 500) reason!: string;
}

export class RespondLoadingLineDto {
  @IsUUID() revisionId!: string;
  @IsIn(["CONFIRM", "COUNTER", "REJECT"])
  responseType!: "CONFIRM" | "COUNTER" | "REJECT";
  @IsOptional() @IsInt() @Min(1) @Max(100_000) counterQuantity?: number;
  @IsOptional() @IsString() @Length(3, 500) reason?: string;
  @IsInt() @Min(1) version!: number;
  @IsString() @Length(8, 100) idempotencyKey!: string;
}

export class ConfirmLoadingSessionDto {
  @IsInt() @Min(1) version!: number;
  @IsString() @Length(8, 100) idempotencyKey!: string;
}
