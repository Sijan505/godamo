import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  ValidateIf,
} from 'class-validator';
import { QueryBoolean, Trim } from '../common/validation.js';

export class CreateGodownDto {
  @ApiProperty({ example: 'Butwal Depot' })
  @Trim()
  @IsString()
  @Length(1, 100)
  name: string;

  @ApiPropertyOptional({ example: 'Traffic Chowk, Butwal' })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 300)
  address?: string;
}

export class UpdateGodownDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 100)
  name?: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @Trim()
  @IsString()
  @Length(1, 300)
  address?: string | null;

  @ApiPropertyOptional({
    description: 'true re-activates a deactivated godown',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ListGodownsQueryDto {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  includeInactive?: boolean;
}
