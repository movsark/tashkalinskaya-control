import { ArrayMaxSize, IsArray, IsIn, IsISO8601, IsString, Length } from "class-validator";

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
}
