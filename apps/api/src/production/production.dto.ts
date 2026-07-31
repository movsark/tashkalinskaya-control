import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
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

export class TaskParticipantDto {
  @IsUUID()
  employeeId!: string;

  @IsBoolean()
  isLead!: boolean;
}

export class AssignProductionTaskDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => TaskParticipantDto)
  participants!: TaskParticipantDto[];

  @IsOptional()
  @IsString()
  @Length(3, 500)
  reason?: string;
}

export class StartProductionTaskDto {
  @IsInt()
  @Min(1)
  version!: number;
}

export class SubmitProductionBatchDto {
  @IsInt()
  @Min(1)
  @Max(100_000)
  quantity!: number;

  @IsISO8601({ strict: true })
  producedAt!: string;

  @IsInt()
  @Min(1)
  taskVersion!: number;

  @IsString()
  @Length(8, 100)
  idempotencyKey!: string;

  @IsOptional()
  @IsUUID()
  reasonId?: string;

  @IsOptional()
  @IsString()
  @Length(3, 500)
  comment?: string;

  @IsOptional()
  @IsUUID()
  replacementForBatchId?: string;
}

export class WithdrawProductionBatchDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsString()
  @Length(3, 500)
  reason!: string;
}

export class DecideOverproductionDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsIn(["APPROVE", "REJECT"])
  decision!: "APPROVE" | "REJECT";

  @IsString()
  @Length(3, 500)
  comment!: string;
}

export class CloseProductionTaskDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsOptional()
  @IsUUID()
  reasonId?: string;

  @IsOptional()
  @IsString()
  @Length(3, 500)
  comment?: string;
}

export class SubmitProductionDefectDto {
  @IsInt()
  @Min(1)
  @Max(100_000)
  quantity!: number;

  @IsUUID()
  reasonId!: string;

  @IsString()
  @Length(3, 500)
  comment!: string;

  @IsISO8601({ strict: true })
  occurredAt!: string;

  @IsString()
  @Length(8, 100)
  idempotencyKey!: string;

  @IsOptional()
  @IsUUID()
  allegedEmployeeId?: string;

  @IsOptional()
  @IsUUID()
  sourceBatchId?: string;
}

export class DecideProductionDefectDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsIn(["CONFIRM", "REJECT", "RETURN"])
  decision!: "CONFIRM" | "REJECT" | "RETURN";

  @IsString()
  @Length(3, 500)
  comment!: string;
}

export class ResubmitProductionDefectDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsString()
  @Length(3, 500)
  comment!: string;
}

export class CreateProductionTransferDto {
  @IsUUID()
  productId!: string;

  @IsUUID()
  fromWorkshopId!: string;

  @IsUUID()
  toWorkshopId!: string;

  @IsISO8601({ strict: true })
  validFrom!: string;

  @IsISO8601({ strict: true })
  validUntil!: string;

  @IsString()
  @Length(3, 500)
  reason!: string;
}

export class DecideProductionTransferDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsIn(["APPROVE", "REJECT"])
  decision!: "APPROVE" | "REJECT";

  @IsString()
  @Length(3, 500)
  comment!: string;
}
