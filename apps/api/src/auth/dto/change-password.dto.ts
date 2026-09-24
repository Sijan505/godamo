import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Length, MaxLength } from 'class-validator';
import { PASSWORD_MAX_LENGTH } from '../../common/validation.js';

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX_LENGTH)
  currentPassword: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @Length(8, PASSWORD_MAX_LENGTH)
  newPassword: string;
}
