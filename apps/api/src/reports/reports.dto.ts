import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { DateOnly } from '../common/validation.js';

export class AgeingQueryDto {
  @ApiPropertyOptional({
    example: '2026-09-30',
    description: 'Age invoices as of this date (default today)',
  })
  @IsOptional()
  @DateOnly()
  asOf?: string;

  @ApiPropertyOptional({ enum: ['total', '90plus'], default: 'total' })
  @IsOptional()
  @IsIn(['total', '90plus'])
  sort?: 'total' | '90plus';
}

export class DateRangeQueryDto {
  @ApiPropertyOptional({ example: '2026-09-01', description: 'Default: today' })
  @IsOptional()
  @DateOnly()
  from?: string;

  @ApiPropertyOptional({ example: '2026-09-30', description: 'Default: today' })
  @IsOptional()
  @DateOnly()
  to?: string;
}
