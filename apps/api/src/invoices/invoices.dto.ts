import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../common/pagination.js';
import { DateOnly, QueryBoolean } from '../common/validation.js';
import { InvoiceStatus } from '../generated/prisma/client.js';
import { MAX_MONEY } from '../pricing/dto/pricing.dto.js';
import { SaleItemDto } from '../sales-orders/sales-orders.dto.js';

export class CreateInvoiceDto {
  @ApiProperty() @IsUUID() partyId: string;

  @ApiPropertyOptional({
    description: "Required unless orderId is given (then the order's godown)",
  })
  @IsOptional()
  @IsUUID()
  godownId?: string;

  @ApiPropertyOptional({ description: 'Bill a CONFIRMED sales order' })
  @IsOptional()
  @IsUUID()
  orderId?: string;

  @ApiPropertyOptional({
    type: [SaleItemDto],
    description:
      "Omit to bill the order's items. No prices: the server prices every line.",
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => SaleItemDto)
  items?: SaleItemDto[];

  @ApiPropertyOptional({
    example: 50,
    description: 'Bill-level discount amount (before VAT)',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_MONEY)
  discountAmount?: number;

  @ApiPropertyOptional({
    description: 'An APPROVED credit approval, if the party is over its limit',
  })
  @IsOptional()
  @IsUUID()
  creditApprovalId?: string;
}

export class ListInvoicesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() partyId?: string;

  @ApiPropertyOptional({ enum: InvoiceStatus, enumName: 'InvoiceStatus' })
  @IsOptional()
  @IsEnum(InvoiceStatus)
  status?: InvoiceStatus;

  @ApiPropertyOptional({ example: '2083/84' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}\/\d{2}$/, { message: 'fiscalYear must look like 2083/84' })
  fiscalYear?: string;

  @ApiPropertyOptional({
    example: '2026-09-01',
    description: 'Invoice date (AD) from',
  })
  @IsOptional()
  @DateOnly()
  from?: string;

  @ApiPropertyOptional({
    example: '2026-09-30',
    description: 'Invoice date (AD) to',
  })
  @IsOptional()
  @DateOnly()
  to?: string;

  @ApiPropertyOptional({
    description: 'Only issued invoices with something still owed',
  })
  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  unpaid?: boolean;

  @ApiPropertyOptional({
    description: 'Only unpaid invoices past invoice date + party credit days',
  })
  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  overdue?: boolean;
}
