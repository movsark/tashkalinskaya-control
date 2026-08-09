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
} from "class-validator";

export class UpdateTerritoryDto {
  @IsString()
  @Length(2, 100)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  description?: string;

  @IsIn(["ACTIVE", "ARCHIVED"])
  status!: "ACTIVE" | "ARCHIVED";

  @IsInt()
  @Min(1)
  version!: number;
}

export class CreateVehicleDto {
  @IsString()
  @Length(3, 20)
  registrationNumber!: string;

  @IsString()
  @Length(2, 100)
  displayName!: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  capacityNote?: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  comment?: string;
}

export class UpdateVehicleDto extends CreateVehicleDto {
  @IsIn(["ACTIVE", "ARCHIVED"])
  status!: "ACTIVE" | "ARCHIVED";

  @IsInt()
  @Min(1)
  version!: number;
}

export class UpsertDriverProfileDto {
  @IsOptional()
  @IsDateString()
  canDriveFrom?: string;

  @IsOptional()
  @IsDateString()
  canDriveTo?: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  comment?: string;

  @IsIn(["ACTIVE", "ARCHIVED"])
  status!: "ACTIVE" | "ARCHIVED";

  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}

export class CreateDefaultAssignmentDto {
  @IsUUID()
  territoryId!: string;

  @IsUUID()
  driverEmployeeId!: string;

  @IsUUID()
  vehicleId!: string;

  @IsDateString()
  validFrom!: string;

  @IsOptional()
  @IsDateString()
  validTo?: string;

  @IsString()
  @Length(2, 50)
  reasonCode!: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  comment?: string;
}

export class CreateLoadingGroupDto {
  @IsDateString()
  dispatchDate!: string;

  @IsInt()
  @Min(1)
  @Max(99)
  groupNo!: number;

  @IsISO8601()
  plannedStartAt!: string;

  @IsISO8601()
  plannedEndAt!: string;

  @IsString()
  @Length(1, 40)
  loadingZone!: string;
}

export class UpdateRunAssignmentDto {
  @IsUUID()
  driverEmployeeId!: string;

  @IsUUID()
  vehicleId!: string;

  @IsOptional()
  @IsUUID()
  loadingGroupId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4)
  sequenceNo?: number;

  @IsISO8601()
  plannedStartAt!: string;

  @IsISO8601()
  plannedEndAt!: string;

  @IsString()
  @Length(2, 50)
  reasonCode!: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  comment?: string;

  @IsInt()
  @Min(1)
  version!: number;
}

export class GenerateDayDto {
  @IsString()
  @Length(8, 100)
  idempotencyKey!: string;
}

export class PublishDayDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsUUID(undefined, { each: true })
  runIds!: string[];
}

export class MarkRunReadyDto {
  @IsString()
  @Length(8, 100)
  idempotencyKey!: string;

  @IsInt()
  @Min(1)
  version!: number;
}

export class CreateExtraRunDto {
  @IsDateString()
  dispatchDate!: string;

  @IsUUID()
  territoryId!: string;

  @IsString()
  @Length(3, 50)
  reasonCode!: string;

  @IsString()
  @Length(3, 500)
  comment!: string;

  @IsString()
  @Length(8, 100)
  idempotencyKey!: string;
}

export class CreateDriverTerritoryRequestDto {
  @IsDateString()
  dispatchDate!: string;

  @IsUUID()
  territoryId!: string;

  @IsString()
  @Length(2, 500)
  reason!: string;
}

export class DecideDriverTerritoryRequestDto {
  @IsIn(["APPROVED", "REJECTED"])
  decision!: "APPROVED" | "REJECTED";

  @IsString()
  @Length(2, 500)
  comment!: string;

  @IsInt()
  @Min(1)
  version!: number;
}
