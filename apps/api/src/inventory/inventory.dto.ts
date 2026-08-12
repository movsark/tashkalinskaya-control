import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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

export class InventoryDateDto {
  @IsDateString() date!: string;
}

export class OpenInventoryDto {
  @IsDateString() businessDate!: string;
  @IsString() @Length(8, 100) idempotencyKey!: string;
  @IsOptional() @IsString() @Length(3, 500) reason?: string;
}

export class CountInventoryLineDto {
  @IsInt() @Min(0) @Max(100_000) actualQuantity!: number;
  @IsInt() @Min(1) version!: number;
  @IsString() @Length(8, 100) idempotencyKey!: string;
}

export class SubmitInventoryDto {
  @IsInt() @Min(1) version!: number;
  @IsString() @Length(8, 100) idempotencyKey!: string;
}

export class ApplyInventoryToPlanDto {
  @IsDateString() productionDate!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID("4", { each: true })
  productIds!: string[];
  @IsString() @Length(8, 100) idempotencyKey!: string;
}

export class ResolveInventoryDiscrepancyDto {
  @IsIn(["EXPLAINED_NO_STOCK_CHANGE", "APPLY_CORRECTION"])
  resolutionCode!: "APPLY_CORRECTION" | "EXPLAINED_NO_STOCK_CHANGE";
  @IsString() @Length(3, 500) comment!: string;
  @IsInt() @Min(1) version!: number;
  @IsString() @Length(8, 100) idempotencyKey!: string;
}
