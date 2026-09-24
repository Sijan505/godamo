import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Length,
  Max,
} from 'class-validator';
import { PaginationQueryDto } from '../common/pagination.js';
import { Trim } from '../common/validation.js';
import { CreditApprovalStatus } from '../generated/prisma/client.js';
import { MAX_MONEY } from '../pricing/dto/pricing.dto.js';

export class RequestCreditApprovalDto {
  @ApiProperty() @IsUUID() partyId: string;

  @ApiProperty({
    example: 75000,
    description: 'Largest invoice total this approval may cover',
  })
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @IsPositive()
  @Max(MAX_MONEY)
  amount: number;

  @ApiProperty({ example: 'Dashain stock; party pays every Friday' })
  @Trim()
  @IsString()
  @Length(3, 500)
  reason: string;
}

export class DecideCreditApprovalDto {
  @ApiPropertyOptional({ example: 'OK for this festival order only' })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 500)
  note?: string;
}

export class ListCreditApprovalsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: CreditApprovalStatus,
    enumName: 'CreditApprovalStatus',
  })
  @IsOptional()
  @IsEnum(CreditApprovalStatus)
  status?: CreditApprovalStatus;

  @ApiPropertyOptional() @IsOptional() @IsUUID() partyId?: string;
}
