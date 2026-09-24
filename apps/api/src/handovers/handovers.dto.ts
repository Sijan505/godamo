import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from '../common/pagination.js';
import { Trim } from '../common/validation.js';
import { HandoverStatus } from '../generated/prisma/client.js';
import { MAX_MONEY } from '../pricing/dto/pricing.dto.js';

export class SubmitHandoverDto {
  @ApiProperty({
    type: [String],
    description: 'Ids from GET /handovers/my-pending',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  paymentIds: string[];
}

export class VerifyHandoverDto {
  @ApiProperty({ example: 15000, description: 'Cash actually counted' })
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_MONEY)
  receivedAmount: number;

  @ApiPropertyOptional({ example: 'Rs 500 short, salesman to bring tomorrow' })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 500)
  note?: string;
}

export class ListHandoversQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: HandoverStatus, enumName: 'HandoverStatus' })
  @IsOptional()
  @IsEnum(HandoverStatus)
  status?: HandoverStatus;

  @ApiPropertyOptional({
    description: 'Ignored for salesmen/drivers (always themselves)',
  })
  @IsOptional()
  @IsUUID()
  fromUserId?: string;
}
