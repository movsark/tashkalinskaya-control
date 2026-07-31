import { IsString, IsUUID, Length, Matches } from "class-validator";

export class ScanAttendanceQrDto {
  @IsUUID()
  idempotencyKey!: string;

  @IsString()
  @Length(20, 160)
  @Matches(/^tkc:a1:[A-Za-z0-9_-]{40,100}$/u)
  payload!: string;
}
