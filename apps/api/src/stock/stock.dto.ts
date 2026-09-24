import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  NotEquals,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../common/pagination.js';
import { DateOnly, Trim } from '../common/validation.js';
import { MovementType, StockCountStatus } from '../generated/prisma/client.js';

const MAX_QTY = 99_999_999_999.999;
const QTY = { maxDecimalPlaces: 3, allowNaN: false, allowInfinity: false };

// ─── Transfers ───────────────────────────────────────────────────────────────

export class TransferItemDto {
  @ApiProperty() @IsUUID() productId: string;
  @ApiProperty() @IsUUID() unitId: string;

  @ApiProperty({ example: 5, description: 'In the chosen unit' })
  @IsNumber(QTY)
  @IsPositive()
  @Max(MAX_QTY)
  quantity: number;

  @ApiPropertyOptional({
    description: 'Batch-tracked products only; omit to pick batches FEFO',
  })
  @IsOptional()
  @IsUUID()
  batchId?: string;
}

export class CreateTransferDto {
  @ApiProperty() @IsUUID() fromGodownId: string;
  @ApiProperty() @IsUUID() toGodownId: string;

  @ApiProperty({ type: [TransferItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => TransferItemDto)
  items: TransferItemDto[];

  @ApiPropertyOptional({ example: 'Weekly stock for the Butwal depot' })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 500)
  note?: string;
}

// ─── Adjustments ─────────────────────────────────────────────────────────────

export class AdjustmentItemDto {
  @ApiProperty() @IsUUID() productId: string;
  @ApiProperty() @IsUUID() unitId: string;

  @ApiProperty({
    example: -2,
    description:
      'In the chosen unit. Positive adds stock, negative removes it.',
  })
  @IsNumber(QTY)
  @NotEquals(0)
  @Min(-MAX_QTY)
  @Max(MAX_QTY)
  quantity: number;

  @ApiPropertyOptional({
    description:
      'Batch-tracked products: required when adding; omit when removing to pick FEFO',
  })
  @IsOptional()
  @IsUUID()
  batchId?: string;
}

export class CreateAdjustmentDto {
  @ApiProperty() @IsUUID() godownId: string;

  @ApiProperty({ enum: ['ADJUSTMENT', 'DAMAGE'] })
  @IsIn([MovementType.ADJUSTMENT, MovementType.DAMAGE])
  type: 'ADJUSTMENT' | 'DAMAGE';

  @ApiProperty({ example: '2 bottles broken while unloading' })
  @Trim()
  @IsString()
  @Length(3, 500)
  reason: string;

  @ApiProperty({ type: [AdjustmentItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AdjustmentItemDto)
  items: AdjustmentItemDto[];
}

// ─── Counts ──────────────────────────────────────────────────────────────────

export class CountItemDto {
  @ApiProperty() @IsUUID() productId: string;

  @ApiPropertyOptional({ description: 'Required for batch-tracked products' })
  @IsOptional()
  @IsUUID()
  batchId?: string;

  @ApiProperty() @IsUUID() unitId: string;

  @ApiProperty({
    example: 48,
    description: 'Physically counted, in the chosen unit',
  })
  @IsNumber(QTY)
  @Min(0)
  @Max(MAX_QTY)
  countedQty: number;
}

export class CreateCountDto {
  @ApiProperty() @IsUUID() godownId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 500)
  note?: string;

  @ApiProperty({ type: [CountItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CountItemDto)
  items: CountItemDto[];
}

export class ListCountsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() godownId?: string;

  @ApiPropertyOptional({ enum: StockCountStatus, enumName: 'StockCountStatus' })
  @IsOptional()
  @IsEnum(StockCountStatus)
  status?: StockCountStatus;
}

// ─── Reports ─────────────────────────────────────────────────────────────────

export class StockListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Omit for all godowns' })
  @IsOptional()
  @IsUUID()
  godownId?: string;

  @ApiPropertyOptional({ description: 'Matches name, SKU or barcode' })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 100)
  search?: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
}

export class StockCardQueryDto {
  @ApiPropertyOptional({ description: 'Omit for all godowns' })
  @IsOptional()
  @IsUUID()
  godownId?: string;

  @ApiPropertyOptional({
    example: '2026-09-01',
    description: 'Nepal date, inclusive',
  })
  @IsOptional()
  @DateOnly()
  from?: string;

  @ApiPropertyOptional({
    example: '2026-09-30',
    description: 'Nepal date, inclusive',
  })
  @IsOptional()
  @DateOnly()
  to?: string;
}

export class GodownFilterQueryDto {
  @ApiPropertyOptional({ description: 'Omit for all godowns' })
  @IsOptional()
  @IsUUID()
  godownId?: string;
}

export class ExpiringQueryDto extends GodownFilterQueryDto {
  @ApiPropertyOptional({ default: 30, minimum: 1, maximum: 730 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(730)
  days: number = 30;
}
