import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
} from "class-validator";

export class ScanAttendanceQrDto {
  @IsUUID()
  idempotencyKey!: string;

  @IsString()
  @Length(20, 160)
  @Matches(/^tkc:a1:[A-Za-z0-9_-]{40,100}$/u)
  payload!: string;
}

export class AttendanceControlQueryDto {
  @IsOptional()
  @IsDateString({ strict: true })
  date?: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;
}

export class ManualAttendanceDto {
  @IsUUID()
  employeeId!: string;

  @IsUUID()
  idempotencyKey!: string;

  @IsUUID()
  reasonId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}

export class CreateAttendanceCorrectionDto {
  @IsUUID()
  workShiftId!: string;

  @IsIn(["ARRIVAL", "DEPARTURE"])
  proposedEventType!: "ARRIVAL" | "DEPARTURE";

  @IsDateString()
  proposedEffectiveAt!: string;

  @IsUUID()
  reasonId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}

export class DecideAttendanceCorrectionDto {
  @IsIn(["APPROVED", "REJECTED"])
  decision!: "APPROVED" | "REJECTED";

  @IsString()
  @Length(3, 500)
  comment!: string;
}

export class AttendanceCorrectionQueryDto {
  @IsOptional()
  @IsIn(["APPROVED", "REJECTED", "SUBMITTED"])
  status?: "APPROVED" | "REJECTED" | "SUBMITTED";
}
