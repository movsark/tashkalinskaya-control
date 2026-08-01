import {
  ArrayMaxSize,
  ArrayMinSize,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

export class GoodReturnLineDto {
  @IsUUID() productId!: string;
  @IsInt() @Min(1) @Max(100_000) quantity!: number;
}

export class ReceiveGoodReturnDto {
  @IsUUID() sourceDriverId!: string;
  @IsDateString({ strict: true }) businessDate!: string;
  @ValidateNested({ each: true })
  @Type(() => GoodReturnLineDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  lines!: GoodReturnLineDto[];
  @IsOptional() @IsString() @Length(3, 500) comment?: string;
  @IsString() @Length(8, 100) idempotencyKey!: string;
}

export class AllocateGoodReturnDto {
  @IsUUID() productId!: string;
  @IsUUID() territoryId!: string;
  @IsDateString({ strict: true }) dispatchDate!: string;
  @IsInt() @Min(1) @Max(100_000) quantity!: number;
  @IsOptional() @IsString() @Length(3, 500) reason?: string;
  @IsString() @Length(8, 100) idempotencyKey!: string;
}

export class ReviseGoodReturnAllocationDto {
  @IsInt() @Min(1) version!: number;
  @IsInt() @Min(1) @Max(100_000) quantity!: number;
  @IsString() @Length(3, 500) reason!: string;
  @IsString() @Length(8, 100) idempotencyKey!: string;
}

export class CancelGoodReturnAllocationDto {
  @IsInt() @Min(1) version!: number;
  @IsString() @Length(3, 500) reason!: string;
  @IsString() @Length(8, 100) idempotencyKey!: string;
}
