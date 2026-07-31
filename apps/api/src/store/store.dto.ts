import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from "class-validator";

export class StoreOrderLineDto {
  @IsUUID()
  productId!: string;

  @IsInt()
  @Min(1)
  @Max(100_000)
  quantity!: number;

  @IsOptional()
  @IsString()
  @Length(0, 300)
  comment?: string;
}

export class SaveStoreDraftDto {
  @IsInt()
  @Min(0)
  draftVersion!: number;

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => StoreOrderLineDto)
  lines!: StoreOrderLineDto[];
}

export class SubmitStoreOrderDto {
  @IsInt()
  @Min(0)
  baseVersionNo!: number;

  @IsBoolean()
  submittedZero!: boolean;

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => StoreOrderLineDto)
  lines!: StoreOrderLineDto[];

  @IsString()
  @Length(8, 100)
  idempotencyKey!: string;
}

export class CreateStoreLateRequestDto {
  @IsBoolean()
  submittedZero!: boolean;

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => StoreOrderLineDto)
  lines!: StoreOrderLineDto[];

  @IsString()
  @Length(3, 500)
  reason!: string;

  @IsString()
  @Length(8, 100)
  idempotencyKey!: string;
}

export class DecideStoreLateRequestDto {
  @IsIn(["APPROVE", "REJECT"])
  decision!: "APPROVE" | "REJECT";

  @IsString()
  @Length(3, 500)
  comment!: string;

  @IsInt()
  @Min(1)
  version!: number;

  @IsString()
  @Length(8, 100)
  idempotencyKey!: string;
}
