import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  NEPALI_MOBILE_MESSAGE,
  NEPALI_MOBILE_REGEX,
  PASSWORD_MAX_LENGTH,
  Trim,
} from '../../common/validation.js';

export class LoginDto {
  @ApiProperty({
    example: 'DEMO',
    description: 'Company code (case-insensitive)',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Length(2, 20)
  companyCode: string;

  @ApiProperty({ example: '9800000000' })
  @Trim()
  @Matches(NEPALI_MOBILE_REGEX, { message: NEPALI_MOBILE_MESSAGE })
  phone: string;

  @ApiProperty({ example: 'admin123' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;
}
