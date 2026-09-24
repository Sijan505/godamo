import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseArrayPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiNoContentResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { MASTER_DATA_WRITE_ROLES } from '../common/roles.js';
import type { AuthUser } from '../common/types/auth-user.js';
import {
  CreatePartyDto,
  ListPartiesQueryDto,
  SpecialPriceItemDto,
  UpdatePartyDto,
} from './dto/party.dto.js';
import { PartiesService } from './parties.service.js';

@ApiTags('Parties')
@ApiBearerAuth()
@Controller('parties')
export class PartiesController {
  constructor(private readonly parties: PartiesService) {}

  @Get()
  @ApiOperation({ summary: 'List customers and suppliers (paginated)' })
  list(@CurrentUser() actor: AuthUser, @Query() query: ListPartiesQueryDto) {
    return this.parties.list(actor, query);
  }

  @Get(':id')
  findOne(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.parties.findOne(actor, id);
  }

  @Roles(...MASTER_DATA_WRITE_ROLES)
  @Post()
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreatePartyDto) {
    return this.parties.create(actor, dto);
  }

  @Roles(...MASTER_DATA_WRITE_ROLES)
  @Patch(':id')
  update(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePartyDto,
  ) {
    return this.parties.update(actor, id, dto);
  }

  @Roles(...MASTER_DATA_WRITE_ROLES)
  @Patch(':id/deactivate')
  deactivate(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.parties.deactivate(actor, id);
  }

  @Get(':id/special-prices')
  listSpecialPrices(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.parties.listSpecialPrices(actor, id);
  }

  @Roles(...MASTER_DATA_WRITE_ROLES)
  @Put(':id/special-prices')
  @ApiOperation({
    summary: 'Set special prices for this party (upsert, one transaction)',
  })
  @ApiBody({ type: [SpecialPriceItemDto] })
  setSpecialPrices(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ParseArrayPipe({
        items: SpecialPriceItemDto,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    items: SpecialPriceItemDto[],
  ) {
    return this.parties.setSpecialPrices(actor, id, items);
  }

  @Roles(...MASTER_DATA_WRITE_ROLES)
  @Delete(':id/special-prices/:productId/:unitId')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove a special price (party falls back to its tier price)',
  })
  @ApiNoContentResponse()
  removeSpecialPrice(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('unitId', ParseUUIDPipe) unitId: string,
  ) {
    return this.parties.removeSpecialPrice(actor, id, productId, unitId);
  }
}
