import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
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
} from 'class-validator';
import { PaginationQueryDto } from '../../common/pagination.js';
import { QueryBoolean, Trim } from '../../common/validation.js';
import { PartyType } from '../../generated/prisma/client.js';
import { MAX_MONEY } from '../../pricing/dto/pricing.dto.js';

const PAN_REGEX = /^\d{9}$/;
const PAN_MESSAGE = 'panVatNo must be exactly 9 digits';
// Parties may give a landline ("01-4270000") as well as a mobile.
const PHONE_REGEX = /^[0-9+\- ]{6,20}$/;
const PHONE_MESSAGE =
  'phone may only contain digits, spaces, + and - (6-20 characters)';

/** Present and not null: lets PATCH send null to clear a field. */
const IsSet = () => ValidateIf((_, v) => v !== null && v !== undefined);

export class CreatePartyDto {
  @ApiProperty({ enum: PartyType, enumName: 'PartyType' })
  @IsEnum(PartyType)
  type: PartyType;

  @ApiProperty({ example: 'Shrestha Kirana Pasal' })
  @Trim()
  @IsString()
  @Length(1, 200)
  name: string;

  @ApiPropertyOptional({ example: 'Hari Shrestha' })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 200)
  ownerName?: string;

  @ApiPropertyOptional({ example: '9841000001' })
  @IsOptional()
  @Trim()
  @Matches(PHONE_REGEX, { message: PHONE_MESSAGE })
  phone?: string;

  @ApiPropertyOptional({ example: '600000102', description: '9 digits' })
  @IsOptional()
  @Trim()
  @Matches(PAN_REGEX, { message: PAN_MESSAGE })
  panVatNo?: string;

  @ApiPropertyOptional({ example: 'Kuleshwor, Kathmandu' })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 300)
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  priceTierId?: string;

  @ApiPropertyOptional({ default: 0, example: 50000 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_MONEY)
  creditLimit?: number;

  @ApiPropertyOptional({ default: 0, example: 15 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  creditDays?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  beatId?: string;
}

export class UpdatePartyDto {
  @ApiPropertyOptional({ enum: PartyType, enumName: 'PartyType' })
  @IsOptional()
  @IsEnum(PartyType)
  type?: PartyType;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 200)
  name?: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsSet()
  @Trim()
  @IsString()
  @Length(1, 200)
  ownerName?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsSet()
  @Trim()
  @Matches(PHONE_REGEX, { message: PHONE_MESSAGE })
  phone?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsSet()
  @Trim()
  @Matches(PAN_REGEX, { message: PAN_MESSAGE })
  panVatNo?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsSet()
  @Trim()
  @IsString()
  @Length(1, 300)
  address?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsSet()
  @IsUUID()
  priceTierId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_MONEY)
  creditLimit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  creditDays?: number;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsSet()
  @IsUUID()
  beatId?: string | null;

  @ApiPropertyOptional({ description: 'true re-activates a deactivated party' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ListPartiesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Matches name, phone or PAN' })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 100)
  search?: string;

  @ApiPropertyOptional({
    enum: PartyType,
    enumName: 'PartyType',
    description: 'CUSTOMER and SUPPLIER also include parties of type BOTH',
  })
  @IsOptional()
  @IsEnum(PartyType)
  type?: PartyType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  beatId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  priceTierId?: string;

  @ApiPropertyOptional({ description: 'Omit to list both active and inactive' })
  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  isActive?: boolean;
}

export class SpecialPriceItemDto {
  @ApiProperty() @IsUUID() productId: string;
  @ApiProperty() @IsUUID() unitId: string;

  @ApiProperty({ example: 620, description: 'Price for ONE of this unit' })
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @IsPositive()
  @Max(MAX_MONEY)
  price: number;
}
