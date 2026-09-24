import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole } from '../../generated/prisma/client.js';

export class TokenPairDto {
  @ApiProperty({
    description: 'Short-lived JWT. Send as "Authorization: Bearer <token>".',
  })
  accessToken: string;

  @ApiProperty({
    description:
      'Long-lived opaque token. Single use: /auth/refresh returns a new one.',
  })
  refreshToken: string;
}

export class LoginUserDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty({ enum: UserRole, enumName: 'UserRole' }) role: UserRole;
  @ApiProperty() tenantId: string;
  @ApiProperty() tenantName: string;
}

export class LoginResponseDto extends TokenPairDto {
  @ApiProperty({ type: LoginUserDto }) user: LoginUserDto;
}

export class ProfileDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() phone: string;
  @ApiPropertyOptional({ nullable: true, type: String }) email: string | null;
  @ApiProperty({ enum: UserRole, enumName: 'UserRole' }) role: UserRole;
  @ApiPropertyOptional({ nullable: true, type: Date }) lastLoginAt: Date | null;
  @ApiProperty() tenantId: string;
  @ApiProperty() tenantName: string;
  @ApiProperty() tenantCode: string;
}
