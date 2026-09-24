import { Body, Controller, Get, Patch } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import type { AuthUser } from '../common/types/auth-user.js';
import { UserRole } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from './settings.service.js';

export class UpdateSettingsDto {
  @ApiPropertyOptional({
    example: 7,
    description: 'Days past due before overdue bills block credit sales',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  overdueGraceDays?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  blockOnOverdue?: boolean;
}

@ApiTags('Settings')
@ApiBearerAuth()
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly prisma: PrismaService,
  ) {}

  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.OFFICE)
  @Get()
  get(@CurrentUser() actor: AuthUser) {
    return this.settings.get(this.prisma, actor.tenantId);
  }

  @Roles(UserRole.OWNER)
  @Patch()
  @ApiOperation({ summary: 'Credit-control settings (owner only)' })
  update(@CurrentUser() actor: AuthUser, @Body() dto: UpdateSettingsDto) {
    return this.settings.update(actor, dto);
  }
}
