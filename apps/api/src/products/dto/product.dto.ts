import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/pagination.js';
import { QueryBoolean, Trim } from '../../common/validation.js';

const MAX_QTY = 99_999_999_999.999;

/** Unit and base-unit names are stored lowercase so "Box" and "box" are the same unit. */
const LowerTrim = () =>
  Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  );

const BARCODE_REGEX = /^[A-Za-z0-9-]+$/;

export class CreateUnitDto {
  @ApiProperty({ example: 'box' })
  @LowerTrim()
  @IsString()
  @Length(1, 20)
  name: string;

  @ApiProperty({
    example: 12,
    description: 'How many BASE units are in one of this unit',
  })
  @IsNumber({ maxDecimalPlaces: 3, allowNaN: false, allowInfinity: false })
  @IsPositive()
  @Max(MAX_QTY)
  factor: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isDefaultSale?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isDefaultPurchase?: boolean;
}

export class UpdateUnitDto {
  @ApiPropertyOptional()
  @IsOptional()
  @LowerTrim()
  @IsString()
  @Length(1, 20)
  name?: string;

  @ApiPropertyOptional({
    description: 'Cannot change once the unit is used in any transaction',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 3, allowNaN: false, allowInfinity: false })
  @IsPositive()
  @Max(MAX_QTY)
  factor?: number;

  @ApiPropertyOptional({
    description:
      'true makes this the default sale unit (the old default is unset)',
  })
  @IsOptional()
  @IsBoolean()
  isDefaultSale?: boolean;

  @ApiPropertyOptional({
    description:
      'true makes this the default purchase unit (the old default is unset)',
  })
  @IsOptional()
  @IsBoolean()
  isDefaultPurchase?: boolean;
}

export class CreateProductDto {
  @ApiProperty({ example: 'FNB-RARA-70' })
  @Trim()
  @IsString()
  @Length(1, 50)
  sku: string;

  @ApiPropertyOptional({ example: '8901234500042' })
  @IsOptional()
  @Trim()
  @Matches(BARCODE_REGEX, {
    message: 'barcode may only contain letters, digits and -',
  })
  @Length(1, 50)
  barcode?: string;

  @ApiProperty({ example: 'Rara Noodles 70g' })
  @Trim()
  @IsString()
  @Length(1, 200)
  name: string;

  @ApiPropertyOptional({ example: 'रारा चाउचाउ ७० ग्राम' })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 200)
  nameNepali?: string;

  @ApiProperty()
  @IsUUID()
  categoryId: string;

  @ApiPropertyOptional({ example: 'Rara' })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 100)
  brand?: string;

  @ApiProperty({
    example: 'pcs',
    description: 'Smallest unit; stock is kept in this unit',
  })
  @LowerTrim()
  @IsString()
  @Length(1, 20)
  baseUnit: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  vatApplicable?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  trackBatch?: boolean;

  @ApiPropertyOptional({ default: 0, description: 'In the base unit' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 3, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_QTY)
  reorderLevel?: number;

  @ApiProperty({
    type: [CreateUnitDto],
    example: [
      { name: 'pcs', factor: 1 },
      { name: 'box', factor: 30, isDefaultSale: true },
      { name: 'carton', factor: 120, isDefaultPurchase: true },
    ],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => CreateUnitDto)
  units: CreateUnitDto[];
}

/** baseUnit can't be changed after creation: stock is already counted in it. */
export class UpdateProductDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 50)
  sku?: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @Trim()
  @Matches(BARCODE_REGEX, {
    message: 'barcode may only contain letters, digits and -',
  })
  @Length(1, 50)
  barcode?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 200)
  name?: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @Trim()
  @IsString()
  @Length(1, 200)
  nameNepali?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @Trim()
  @IsString()
  @Length(1, 100)
  brand?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  vatApplicable?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  trackBatch?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 3, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_QTY)
  reorderLevel?: number;

  @ApiPropertyOptional({
    description: 'true re-activates a deactivated product',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ListProductsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Matches name, SKU or barcode' })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 100)
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 100)
  brand?: string;

  @ApiPropertyOptional({ description: 'Omit to list both active and inactive' })
  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  isActive?: boolean;
}
