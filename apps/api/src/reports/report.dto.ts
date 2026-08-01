import { Type } from "class-transformer";
import { IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { REPORT_CODES, type ReportCode, type ReportExportFormat } from "@tashkalinskaya/contracts";

export class ControlCenterQueryDto {
  @IsDateString({ strict: true })
  date!: string;
}

export class ReportJobQueryDto {
  @IsOptional()
  @IsDateString({ strict: true })
  dateFrom?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  dateTo?: string;

  @IsOptional()
  @IsIn(REPORT_CODES)
  reportCode?: ReportCode;

  @IsOptional()
  @Type(() => Number)
  limit?: number;
}

export class CreateReportJobDto {
  @IsDateString({ strict: true })
  dateFrom!: string;

  @IsDateString({ strict: true })
  dateTo!: string;

  @IsIn(["XLSX", "PDF"])
  format!: ReportExportFormat;

  @IsOptional()
  @IsUUID()
  scopeId?: string;

  @IsIn(REPORT_CODES)
  reportCode!: ReportCode;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  scopeLabel?: string;
}
