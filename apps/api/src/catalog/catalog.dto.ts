import { ArrayMaxSize, IsArray, IsISO8601, IsString } from "class-validator";

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
