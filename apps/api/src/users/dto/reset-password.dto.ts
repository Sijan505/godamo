import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { PASSWORD_MAX_LENGTH } from '../../common/validation.js';

export class ResetPasswordDto {
  @ApiProperty({ minLength: 8 })
  @IsString()
  @Length(8, PASSWORD_MAX_LENGTH)
  newPassword: string;
}
