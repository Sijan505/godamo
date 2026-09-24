import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Length,
  Max,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../common/pagination.js';
import { DateOnly, Trim } from '../common/validation.js';
import {
  ChequeStatus,
  PaymentDirection,
  PaymentMethod,
  PaymentStatus,
} from '../generated/prisma/client.js';
import { MAX_MONEY } from '../pricing/dto/pricing.dto.js';

const MONEY = { maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false };

export class AllocationDto {
  @ApiProperty() @IsUUID() invoiceId: string;

  @ApiProperty({ example: 5000 })
  @IsNumber(MONEY)
  @IsPositive()
  @Max(MAX_MONEY)
  amount: number;
}

export class ReceivePaymentDto {
  @ApiProperty() @IsUUID() partyId: string;

  @ApiProperty({ example: 10000 })
  @IsNumber(MONEY)
  @IsPositive()
  @Max(MAX_MONEY)
  amount: number;

  @ApiProperty({ enum: PaymentMethod, enumName: 'PaymentMethod' })
  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  @ApiPropertyOptional({
    description: 'Bank / Fonepay / eSewa / Khalti transaction id',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 100)
  referenceNo?: string;

  @ApiPropertyOptional({ description: 'Required for CHEQUE' })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 30)
  chequeNo?: string;

  @ApiPropertyOptional({
    example: 'Nabil Bank',
    description: 'Required for CHEQUE',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 100)
  chequeBank?: string;

  @ApiPropertyOptional({
    example: '2026-10-01',
    description: 'Required for CHEQUE',
  })
  @IsOptional()
  @DateOnly()
  chequeDate?: string;

  @ApiPropertyOptional({
    type: [AllocationDto],
    description: 'Omit to settle the oldest unpaid invoices first (FIFO)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AllocationDto)
  allocations?: AllocationDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 500)
  note?: string;

  @ApiPropertyOptional({
    description:
      'Unique id from the (offline) client; a repeat returns the existing payment',
  })
  @IsOptional()
  @IsUUID()
  clientUuid?: string;
}

export class PaySupplierDto {
  @ApiProperty() @IsUUID() supplierId: string;

  @ApiProperty({ example: 25000 })
  @IsNumber(MONEY)
  @IsPositive()
  @Max(MAX_MONEY)
  amount: number;

  @ApiProperty({ enum: PaymentMethod, enumName: 'PaymentMethod' })
  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  @ApiPropertyOptional({ description: 'Cheque no. / bank transaction id' })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 100)
  referenceNo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 500)
  note?: string;
}

export class ReasonDto {
  @ApiProperty({ example: 'Entered against the wrong party' })
  @Trim()
  @IsString()
  @Length(3, 500)
  reason: string;
}

export class ListPaymentsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() partyId?: string;

  @ApiPropertyOptional({ enum: PaymentDirection, enumName: 'PaymentDirection' })
  @IsOptional()
  @IsEnum(PaymentDirection)
  direction?: PaymentDirection;

  @ApiPropertyOptional({ enum: PaymentMethod, enumName: 'PaymentMethod' })
  @IsOptional()
  @IsEnum(PaymentMethod)
  method?: PaymentMethod;

  @ApiPropertyOptional({
    description: 'Ignored for salesmen/drivers (always themselves)',
  })
  @IsOptional()
  @IsUUID()
  collectedById?: string;

  @ApiPropertyOptional({ enum: ChequeStatus, enumName: 'ChequeStatus' })
  @IsOptional()
  @IsEnum(ChequeStatus)
  chequeStatus?: ChequeStatus;

  @ApiPropertyOptional({ enum: PaymentStatus, enumName: 'PaymentStatus' })
  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsOptional()
  @DateOnly()
  from?: string;

  @ApiPropertyOptional({ example: '2026-09-30' })
  @IsOptional()
  @DateOnly()
  to?: string;
}
