import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from "class-validator";

export class CreateWriteoffRequestDto {
  @IsIn(["RETURN_POOL", "PHYSICAL_SPOILAGE"])
  sourceKind!: "RETURN_POOL" | "PHYSICAL_SPOILAGE";
  @IsOptional()
  @IsIn(["DRIVER", "STORE", "OTHER"])
  physicalSourceKind?: "DRIVER" | "STORE" | "OTHER";
  @IsOptional() @IsUUID() sourceDriverId?: string;
  @IsOptional() @IsString() @Length(2, 200) sourceLabel?: string;
  @IsUUID() productId!: string;
  @IsInt() @Min(1) @Max(100_000) quantity!: number;
  @IsUUID() reasonId!: string;
  @IsString() @Length(3, 500) comment!: string;
  @IsDateString({ strict: true }) businessDate!: string;
  @IsOptional() @IsString() @Length(1, 100) externalDocumentNumber?: string;
  @IsOptional() @IsUUID() photoUploadId?: string;
  @IsString() @Length(8, 100) idempotencyKey!: string;
}

export class CreateDriverSpoilageRequestDto {
  @IsUUID() territoryId!: string;
  @IsDateString({ strict: true }) dispatchDate!: string;
  @IsUUID() productId!: string;
  @IsInt() @Min(1) @Max(100_000) quantity!: number;
  @IsUUID() reasonId!: string;
  @IsString() @Length(3, 500) comment!: string;
  @IsOptional() @IsUUID() photoUploadId?: string;
  @IsString() @Length(8, 100) idempotencyKey!: string;
}

export class DecideWriteoffRequestDto {
  @IsIn(["APPROVE", "REJECT"]) decision!: "APPROVE" | "REJECT";
  @IsString() @Length(3, 500) comment!: string;
  @IsInt() @Min(1) version!: number;
  @IsString() @Length(8, 100) idempotencyKey!: string;
}

export class CheckExternalDocumentDto {
  @IsIn(["MATCHED", "MISMATCH"]) result!: "MATCHED" | "MISMATCH";
  @IsString() @Length(1, 100) externalDocumentNumber!: string;
  @IsOptional() @IsString() @Length(3, 500) comment?: string;
  @IsString() @Length(8, 100) idempotencyKey!: string;
}
