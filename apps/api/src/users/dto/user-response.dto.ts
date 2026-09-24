import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole } from '../../generated/prisma/client.js';

export class UserResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() phone: string;
  @ApiPropertyOptional({ nullable: true, type: String }) email: string | null;
  @ApiProperty({ enum: UserRole, enumName: 'UserRole' }) role: UserRole;
  @ApiProperty() isActive: boolean;
  @ApiPropertyOptional({ nullable: true, type: Date }) lastLoginAt: Date | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}
