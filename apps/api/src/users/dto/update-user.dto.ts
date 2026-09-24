import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';
import { UserRole } from '../../generated/prisma/client.js';
import { Trim } from '../../common/validation.js';

export class UpdateUserDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @Length(2, 100)
  name?: string;

  @ApiPropertyOptional({ enum: UserRole, enumName: 'UserRole' })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @ApiPropertyOptional({
    description: 'false deactivates the user and logs out all their sessions',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
