import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNumber, IsOptional, IsPositive, Max } from 'class-validator';
import { DateOnly } from '../common/validation.js';
import { MAX_MONEY } from '../pricing/dto/pricing.dto.js';

export class OpeningBalanceDto {
  @ApiProperty({ example: 25000 })
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @IsPositive()
  @Max(MAX_MONEY)
  amount: number;

  @ApiProperty({
    enum: ['RECEIVABLE', 'PAYABLE'],
    description:
      'RECEIVABLE: they owe us (debit). PAYABLE: we owe them (credit).',
  })
  @IsIn(['RECEIVABLE', 'PAYABLE'])
  type: 'RECEIVABLE' | 'PAYABLE';

  @ApiProperty({
    example: '2026-07-16',
    description: 'Usually the day before the fiscal year starts',
  })
  @DateOnly()
  asOfDate: string;
}

export class LedgerQueryDto {
  @ApiPropertyOptional({
    example: '2026-07-17',
    description: 'Entry date (AD) from, inclusive',
  })
  @IsOptional()
  @DateOnly()
  from?: string;

  @ApiPropertyOptional({
    example: '2026-09-30',
    description: 'Entry date (AD) to, inclusive',
  })
  @IsOptional()
  @DateOnly()
  to?: string;
}
