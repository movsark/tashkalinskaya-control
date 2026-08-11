import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from "class-validator";

export class PreviewCatalogImportDto {
  @IsISO8601({ strict: true })
  effectiveFrom!: string;
}

export class ApplyCatalogImportDto {
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  acknowledgedWarningCodes!: string[];
}

export class CreateCatalogProductDto {
  @IsIn(["BASIC_CAKES", "PREMIUM_CAKES", "PIES_AND_PASTRIES", "DESSERTS", "DRY_BAKERY"])
  categoryCode!: string;

  @IsString()
  @Length(2, 200)
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  dailyNormQuantity?: number;
}
