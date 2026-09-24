import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsString, Length, Matches } from 'class-validator';
import { UserRole } from '../../generated/prisma/client.js';
import {
  NEPALI_MOBILE_MESSAGE,
  NEPALI_MOBILE_REGEX,
  PASSWORD_MAX_LENGTH,
  Trim,
} from '../../common/validation.js';

export class CreateUserDto {
  @ApiProperty({ example: 'Shyam Office' })
  @Trim()
  @IsString()
  @Length(2, 100)
  name: string;

  @ApiProperty({ example: '9811111111' })
  @Trim()
  @Matches(NEPALI_MOBILE_REGEX, { message: NEPALI_MOBILE_MESSAGE })
  phone: string;

  @ApiProperty({
    enum: UserRole,
    enumName: 'UserRole',
    example: UserRole.OFFICE,
  })
  @IsEnum(UserRole)
  role: UserRole;

  @ApiProperty({ minLength: 8, example: 'office123' })
  @IsString()
  @Length(8, PASSWORD_MAX_LENGTH)
  password: string;
}
