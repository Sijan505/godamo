import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { MASTER_DATA_WRITE_ROLES } from '../common/roles.js';
import type { AuthUser } from '../common/types/auth-user.js';
import {
  CreateProductDto,
  CreateUnitDto,
  ListProductsQueryDto,
  UpdateProductDto,
  UpdateUnitDto,
} from './dto/product.dto.js';
import { ProductImportService } from './product-import.service.js';
import { ProductsService } from './products.service.js';

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

// Declared before ProductsController so /products/import/* never hits /products/:id.
@ApiTags('Products')
@ApiBearerAuth()
@Controller('products/import')
export class ProductImportController {
  constructor(private readonly importer: ProductImportService) {}

  @Get('template')
  @ApiOperation({ summary: 'Download the Excel import template' })
  @ApiProduces(XLSX_MIME)
  @ApiOkResponse({ description: 'godamo-products-template.xlsx' })
  async template() {
    return new StreamableFile(await this.importer.template(), {
      type: XLSX_MIME,
      disposition: 'attachment; filename="godamo-products-template.xlsx"',
    });
  }

  @Roles(...MASTER_DATA_WRITE_ROLES)
  @Post()
  @ApiOperation({
    summary:
      'Import products from .xlsx (max 5 MB). All rows are validated first; any error imports nothing.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOkResponse({
    schema: { example: { created: 12, updated: 3 } },
  })
  @ApiBadRequestResponse({
    description: 'Row errors: { message, errors: [{ row, errors[] }] }',
  })
  @ApiPayloadTooLargeResponse({ description: 'File larger than 5 MB' })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_IMPORT_BYTES, files: 1 },
    }),
  )
  import(
    @CurrentUser() actor: AuthUser,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('Upload an .xlsx file in the "file" field');
    }
    if (!file.originalname.toLowerCase().endsWith('.xlsx')) {
      throw new BadRequestException('Only .xlsx files are supported');
    }
    return this.importer.import(actor, file.buffer);
  }
}

@ApiTags('Products')
@ApiBearerAuth()
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @ApiOperation({ summary: 'List products (paginated, searchable)' })
  list(@CurrentUser() actor: AuthUser, @Query() query: ListProductsQueryDto) {
    return this.products.list(actor, query);
  }

  @Get('barcode/:code')
  @ApiOperation({ summary: 'Scanner lookup by barcode' })
  findByBarcode(@CurrentUser() actor: AuthUser, @Param('code') code: string) {
    return this.products.findByBarcode(actor, code);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Product with units and all tier prices' })
  findOne(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.products.findOne(actor, id);
  }

  @Roles(...MASTER_DATA_WRITE_ROLES)
  @Post()
  @ApiOperation({
    summary: 'Create a product and its units in one transaction',
  })
  @ApiConflictResponse({ description: 'SKU or barcode already in use' })
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreateProductDto) {
    return this.products.create(actor, dto);
  }

  @Roles(...MASTER_DATA_WRITE_ROLES)
  @Patch(':id')
  @ApiConflictResponse({ description: 'SKU or barcode already in use' })
  update(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.products.update(actor, id, dto);
  }

  @Roles(...MASTER_DATA_WRITE_ROLES)
  @Patch(':id/deactivate')
  deactivate(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.products.deactivate(actor, id);
  }

  @Roles(...MASTER_DATA_WRITE_ROLES)
  @Post(':id/units')
  @ApiOperation({ summary: 'Add a unit (e.g. "pack" = 6 pcs)' })
  addUnit(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateUnitDto,
  ) {
    return this.products.addUnit(actor, id, dto);
  }

  @Roles(...MASTER_DATA_WRITE_ROLES)
  @Patch(':id/units/:unitId')
  @ApiConflictResponse({
    description: 'Factor change on a unit already used in transactions',
  })
  updateUnit(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Body() dto: UpdateUnitDto,
  ) {
    return this.products.updateUnit(actor, id, unitId, dto);
  }
}
