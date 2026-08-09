import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

export class NormRequestLineDto {
  @IsUUID()
  productId!: string;

  @IsInt()
  @Min(0)
  @Max(100_000)
  quantity!: number;
}

export class TerritoryDailyNormLineDto {
  @IsUUID()
  productId!: string;

  @IsInt()
  @Min(0)
  @Max(100_000)
  quantity!: number;
}

export class SaveTerritoryDailyNormDto {
  @IsDateString()
  dispatchDate!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => TerritoryDailyNormLineDto)
  lines!: TerritoryDailyNormLineDto[];

  @IsString()
  @Length(3, 500)
  reason!: string;
}

export class CreateNormRequestDto {
  @IsIn(["MONTH_WEEKDAY", "PERMANENT", "ONE_OFF"])
  kind!: "MONTH_WEEKDAY" | "PERMANENT" | "ONE_OFF";

  @IsUUID()
  territoryId!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(7)
  dispatchWeekday?: number;

  @IsOptional()
  @IsDateString()
  dispatchDate?: string;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;

  @IsOptional()
  @IsDateString()
  effectiveUntil?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => NormRequestLineDto)
  lines!: NormRequestLineDto[];

  @IsOptional()
  @IsString()
  @Length(0, 500)
  comment?: string;
}

export class DecideNormRequestDto {
  @IsIn(["APPROVE", "REJECT"])
  decision!: "APPROVE" | "REJECT";

  @IsString()
  @Length(3, 500)
  comment!: string;

  @IsInt()
  @Min(1)
  version!: number;
}

export class CreateCalendarLinkDto {
  @IsDateString()
  productionDate!: string;

  @IsDateString()
  dispatchDate!: string;

  @IsOptional()
  @IsUUID()
  territoryId?: string;

  @IsISO8601()
  cutoffAt!: string;

  @IsIn(["STANDARD", "HOLIDAY", "EXTRA_WORK"])
  exceptionType!: "STANDARD" | "HOLIDAY" | "EXTRA_WORK";

  @IsString()
  @Length(3, 50)
  reasonCode!: string;

  @IsString()
  @Length(3, 500)
  comment!: string;
}

export class RunProductionPlanDto {
  @IsString()
  @Length(8, 100)
  idempotencyKey!: string;
}

export class OverrideProductionPlanDto {
  @IsUUID()
  productId!: string;

  @IsInt()
  @Min(0)
  @Max(1_000_000)
  quantity!: number;

  @IsString()
  @Length(3, 500)
  reason!: string;

  @IsString()
  @Length(8, 100)
  idempotencyKey!: string;
}
