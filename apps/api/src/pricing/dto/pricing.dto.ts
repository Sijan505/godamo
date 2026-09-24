import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
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
  Max,
  ValidateNested,
} from 'class-validator';
import { QueryBoolean, Trim } from '../../common/validation.js';

export const MAX_MONEY = 999_999_999_999.99;

// ─── Tiers ───────────────────────────────────────────────────────────────────

export class CreatePriceTierDto {
  @ApiProperty({ example: 'Wholesaler' })
  @Trim()
  @IsString()
  @Length(1, 50)
  name: string;
}

export class UpdatePriceTierDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 50)
  name?: string;

  @ApiPropertyOptional({ description: 'false deactivates the tier' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ListPriceTiersQueryDto {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  includeInactive?: boolean;
}

// ─── Product prices ──────────────────────────────────────────────────────────

export class ProductPriceItemDto {
  @ApiProperty({ description: 'A unit of this product' })
  @IsUUID()
  unitId: string;

  @ApiProperty()
  @IsUUID()
  priceTierId: string;

  @ApiProperty({ example: 653.4, description: 'Price for ONE of this unit' })
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @IsPositive()
  @Max(MAX_MONEY)
  price: number;
}

export class ProductPriceDto {
  @ApiProperty() unitId: string;
  @ApiProperty() unitName: string;
  @ApiProperty() priceTierId: string;
  @ApiProperty() tierName: string;
  @ApiProperty({ example: '653.40' }) price: string;
}

// ─── Resolution ──────────────────────────────────────────────────────────────

export class ResolvePriceQueryDto {
  @ApiProperty() @IsUUID() partyId: string;
  @ApiProperty() @IsUUID() productId: string;
  @ApiProperty() @IsUUID() unitId: string;
}

export class ResolveItemDto {
  @ApiProperty() @IsUUID() productId: string;
  @ApiProperty() @IsUUID() unitId: string;
}

export class ResolveBulkDto {
  @ApiProperty()
  @IsUUID()
  partyId: string;

  @ApiProperty({ type: [ResolveItemDto], maxItems: 200 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ResolveItemDto)
  items: ResolveItemDto[];
}

export class ResolvedPriceDto {
  @ApiProperty({ example: '653.40' }) price: string;
  @ApiProperty({ enum: ['SPECIAL', 'TIER', 'DERIVED'] }) source: string;
  @ApiProperty({ example: 'box' }) unitName: string;
}

export class ResolvedBulkItemDto {
  @ApiProperty() productId: string;
  @ApiProperty() unitId: string;
  @ApiPropertyOptional({ nullable: true, type: String }) unitName:
    string | null;
  @ApiPropertyOptional({ nullable: true, type: String, example: '653.40' })
  price: string | null;
  @ApiPropertyOptional({
    nullable: true,
    enum: ['SPECIAL', 'TIER', 'DERIVED'],
  })
  source: string | null;
  @ApiPropertyOptional({
    description: 'Set when no price could be resolved for this item',
    example: 'No price set',
  })
  error?: string;
}
