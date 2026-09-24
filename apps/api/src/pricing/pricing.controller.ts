import {
  Body,
  Controller,
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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { PaginationQueryDto } from '../common/pagination.js';
import { MASTER_DATA_WRITE_ROLES } from '../common/roles.js';
import type { AuthUser } from '../common/types/auth-user.js';
import {
  CreatePriceTierDto,
  ListPriceTiersQueryDto,
  ProductPriceDto,
  ProductPriceItemDto,
  ResolveBulkDto,
  ResolvedBulkItemDto,
  ResolvedPriceDto,
  ResolvePriceQueryDto,
  UpdatePriceTierDto,
} from './dto/pricing.dto.js';
import { PricingService } from './pricing.service.js';

@ApiTags('Pricing')
@ApiBearerAuth()
@Controller('price-tiers')
export class PriceTiersController {
  constructor(private readonly pricing: PricingService) {}

  @Get()
  list(@CurrentUser() actor: AuthUser, @Query() query: ListPriceTiersQueryDto) {
    return this.pricing.listTiers(actor, query.includeInactive);
  }

  @Roles(...MASTER_DATA_WRITE_ROLES)
  @Post()
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreatePriceTierDto) {
    return this.pricing.createTier(actor, dto);
  }

  @Roles(...MASTER_DATA_WRITE_ROLES)
  @Patch(':id')
  @ApiOkResponse({ description: 'Use { "isActive": false } to deactivate' })
  update(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePriceTierDto,
  ) {
    return this.pricing.updateTier(actor, id, dto);
  }
}

@ApiTags('Pricing')
@ApiBearerAuth()
@Controller('products')
export class ProductPricesController {
  constructor(private readonly pricing: PricingService) {}

  @Get(':id/prices')
  @ApiOkResponse({ type: [ProductPriceDto] })
  list(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.pricing.getProductPrices(actor.tenantId, id);
  }

  @Roles(...MASTER_DATA_WRITE_ROLES)
  @Put(':id/prices')
  @ApiOperation({
    summary: 'Set tier prices for a product (upsert, one transaction)',
  })
  @ApiBody({ type: [ProductPriceItemDto] })
  @ApiOkResponse({ type: [ProductPriceDto], description: 'All prices now set' })
  setPrices(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ParseArrayPipe({
        items: ProductPriceItemDto,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    items: ProductPriceItemDto[],
  ) {
    return this.pricing.setProductPrices(actor, id, items);
  }

  @Get(':id/price-history')
  @ApiOperation({ summary: 'Price changes for a product, newest first' })
  priceHistory(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.pricing.priceHistory(actor, id, query);
  }
}

@ApiTags('Pricing')
@ApiBearerAuth()
@Controller('pricing')
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  @Get('resolve')
  @ApiOperation({
    summary:
      'Price for a party + product + unit: special > tier > base tier price × factor',
  })
  @ApiOkResponse({ type: ResolvedPriceDto })
  @ApiNotFoundResponse({ description: 'Party, product or unit not found' })
  @ApiUnprocessableEntityResponse({ description: 'No price set' })
  resolve(
    @CurrentUser() actor: AuthUser,
    @Query() query: ResolvePriceQueryDto,
  ) {
    return this.pricing.resolve(
      actor,
      query.partyId,
      query.productId,
      query.unitId,
    );
  }

  @Post('resolve-bulk')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Resolve many items for one party; unresolvable items carry an error',
  })
  @ApiOkResponse({ type: [ResolvedBulkItemDto] })
  resolveBulk(@CurrentUser() actor: AuthUser, @Body() dto: ResolveBulkDto) {
    return this.pricing.resolveMany(actor, dto.partyId, dto.items);
  }
}
