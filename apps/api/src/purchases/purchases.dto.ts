import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../common/pagination.js';
import { DateOnly, Trim } from '../common/validation.js';
import { PurchaseStatus } from '../generated/prisma/client.js';
import { MAX_MONEY } from '../pricing/dto/pricing.dto.js';

export const MAX_QTY = 99_999_999_999.999;

export class PurchaseItemDto {
  @ApiProperty() @IsUUID() productId: string;
  @ApiProperty() @IsUUID() unitId: string;

  @ApiProperty({ example: 10, description: 'In the chosen unit' })
  @IsNumber({ maxDecimalPlaces: 3, allowNaN: false, allowInfinity: false })
  @IsPositive()
  @Max(MAX_QTY)
  quantity: number;

  @ApiProperty({
    example: 2600,
    description: 'Price for ONE of the chosen unit, before VAT',
  })
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_MONEY)
  rate: number;

  @ApiPropertyOptional({ default: 0, description: 'Line discount amount' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_MONEY)
  discount?: number;

  @ApiPropertyOptional({ description: 'Required for batch-tracked products' })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 50)
  batchNo?: string;

  @ApiPropertyOptional({ example: '2027-06-30' })
  @IsOptional()
  @DateOnly()
  expiryDate?: string;

  @ApiPropertyOptional({ example: '2026-08-01' })
  @IsOptional()
  @DateOnly()
  mfgDate?: string;
}

export class CreatePurchaseDto {
  @ApiProperty() @IsUUID() supplierId: string;
  @ApiProperty() @IsUUID() godownId: string;

  @ApiProperty({ example: 'HFS-2083-0457' })
  @Trim()
  @IsString()
  @Length(1, 50)
  supplierBillNo: string;

  @ApiProperty({ example: '2026-09-25' })
  @DateOnly()
  purchaseDate: string;

  @ApiPropertyOptional({
    default: 0,
    description: 'Bill-level discount amount',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_MONEY)
  discount?: number;

  @ApiProperty({ type: [PurchaseItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => PurchaseItemDto)
  items: PurchaseItemDto[];
}

export class CancelPurchaseDto {
  @ApiProperty({ example: 'Entered against the wrong supplier' })
  @Trim()
  @IsString()
  @Length(3, 500)
  reason: string;
}

export class ListPurchasesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplierId?: string;

  @ApiPropertyOptional({
    example: '2026-09-01',
    description: 'Purchase date from (inclusive)',
  })
  @IsOptional()
  @DateOnly()
  from?: string;

  @ApiPropertyOptional({
    example: '2026-09-30',
    description: 'Purchase date to (inclusive)',
  })
  @IsOptional()
  @DateOnly()
  to?: string;

  @ApiPropertyOptional({ enum: PurchaseStatus, enumName: 'PurchaseStatus' })
  @IsOptional()
  @IsEnum(PurchaseStatus)
  status?: PurchaseStatus;
}
