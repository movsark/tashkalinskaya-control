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

export class ClaimWarehouseBatchDto {
  @IsInt() @Min(1) version!: number;
}

export class ReleaseWarehouseBatchDto {
  @IsString() @Length(3, 500) reason!: string;
}

export class ReceiveWarehouseBatchDto {
  @IsInt() @Min(0) @Max(100_000) acceptedQuantity!: number;
  @IsInt() @Min(1) version!: number;
  @IsString() @Length(8, 100) idempotencyKey!: string;
  @IsOptional() @IsUUID() reasonId?: string;
  @IsOptional() @IsString() @Length(3, 500) comment?: string;
}

export class TransferWarehousePickupDto {
  @IsUUID() productId!: string;
  @IsUUID() workshopId!: string;
  @IsDateString({ strict: true }) productionDate!: string;
  @IsIn(["DAY", "NIGHT"]) productionWindow!: "DAY" | "NIGHT";
  @IsInt() @Min(1) @Max(100_000) quantity!: number;
  @IsString() @Length(8, 100) idempotencyKey!: string;
}

export class ExplainWarehouseDiscrepancyDto {
  @IsInt() @Min(1) version!: number;
  @IsString() @Length(3, 500) explanation!: string;
}

export class ResolveWarehouseDiscrepancyDto {
  @IsInt() @Min(1) version!: number;
  @IsIn([
    "EXPLAINED_NO_STOCK_CHANGE",
    "REPLACEMENT_BATCH_RECEIVED",
    "ADMIN_CORRECTION_APPLIED",
    "DOCUMENTED_LOSS",
    "OTHER",
  ])
  resolutionCode!: string;
  @IsString() @Length(3, 500) comment!: string;
}

export class CreateWarehouseCorrectionDto {
  @IsUUID() productId!: string;
  @IsIn([
    "FREE_STOCK",
    "RESERVED_FOR_LOADING",
    "RESERVED_FOR_STORE",
    "RETURN_POOL",
    "BLOCKED_FOR_WRITEOFF",
  ])
  bucket!: string;
  @IsIn(["INCREASE", "DECREASE"]) direction!: "INCREASE" | "DECREASE";
  @IsInt() @Min(1) @Max(100_000) quantity!: number;
  @IsUUID() reasonId!: string;
  @IsString() @Length(3, 500) comment!: string;
  @IsString() @Length(8, 100) idempotencyKey!: string;
  @IsOptional() @IsUUID() relatedDocumentId?: string;
}
