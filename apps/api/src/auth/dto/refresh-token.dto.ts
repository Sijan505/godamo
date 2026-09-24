import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({
    description: 'The refresh token returned by /auth/login or /auth/refresh',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  refreshToken: string;
}
