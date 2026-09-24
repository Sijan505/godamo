import { BadRequestException, Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../common/types/auth-user.js';
import { AuditAction, Prisma } from '../generated/prisma/client.js';
import { PricingService, type PriceRow } from '../pricing/pricing.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductsService } from './products.service.js';
import { validateUnitSet } from './unit-rules.js';

type Decimal = Prisma.Decimal;
const { Decimal } = Prisma;

export const IMPORT_COLUMNS = [
  'sku',
  'name',
  'nameNepali',
  'category',
  'brand',
  'baseUnit',
  'box_factor',
  'carton_factor',
  'retailer_price',
  'subdealer_price',
  'bulk_price',
  'vatApplicable',
  'reorderLevel',
  'barcode',
] as const;
type Column = (typeof IMPORT_COLUMNS)[number];

const REQUIRED_COLUMNS: Column[] = ['sku', 'name', 'category', 'baseUnit'];
const MAX_ROWS = 1000;

/** Price columns -> price tier, matched by name ignoring case, spaces and dashes. */
const PRICE_COLUMNS = [
  { column: 'retailer_price', tierKey: 'retailer', label: 'Retailer' },
  { column: 'subdealer_price', tierKey: 'subdealer', label: 'Sub-dealer' },
  { column: 'bulk_price', tierKey: 'bulk', label: 'Bulk' },
] as const;

const tierKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

type Cell = string | number | boolean | null;

interface ParsedRow {
  row: number;
  sku: string;
  name: string;
  nameNepali?: string;
  category: string;
  brand?: string;
  baseUnit: string;
  boxFactor?: Decimal;
  cartonFactor?: Decimal;
  prices: { tierKey: string; label: string; price: Decimal }[];
  vatApplicable?: boolean;
  reorderLevel?: Decimal;
  barcode?: string;
}

export interface RowError {
  row: number;
  errors: string[];
}

@Injectable()
export class ProductImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly pricing: PricingService,
    private readonly products: ProductsService,
  ) {}

  async template(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Products');
    sheet.columns = IMPORT_COLUMNS.map((c) => ({
      header: c,
      key: c,
      width: c === 'name' || c === 'nameNepali' ? 30 : 16,
    }));
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    const help = wb.addWorksheet('Instructions');
    help.columns = [
      { header: 'Column', key: 'column', width: 18 },
      { header: 'Required', key: 'required', width: 10 },
      { header: 'Meaning', key: 'meaning', width: 70 },
      { header: 'Example', key: 'example', width: 28 },
    ];
    help.getRow(1).font = { bold: true };
    help.addRows([
      [
        'sku',
        'yes',
        'Your product code. Existing SKU = update, new SKU = create.',
        'FNB-RARA-70',
      ],
      ['name', 'yes', 'Product name', 'Rara Noodles 70g'],
      ['nameNepali', '', 'Name in Nepali', 'रारा चाउचाउ'],
      [
        'category',
        'yes',
        'Category name; created automatically if it does not exist',
        'Food & Beverage',
      ],
      ['brand', '', 'Brand', 'Rara'],
      [
        'baseUnit',
        'yes',
        'Smallest unit; stock is counted in this unit. Cannot change later.',
        'pcs',
      ],
      ['box_factor', '', 'Base units in one box (creates a "box" unit)', 30],
      [
        'carton_factor',
        '',
        'Base units in one carton (creates a "carton" unit)',
        120,
      ],
      ['retailer_price', '', 'Retailer price for ONE base unit', 22],
      ['subdealer_price', '', 'Sub-dealer price for ONE base unit', 21.5],
      ['bulk_price', '', 'Bulk price for ONE base unit', 21],
      ['vatApplicable', '', 'yes / no (blank = yes for new products)', 'yes'],
      ['reorderLevel', '', 'Reorder level in base units', 600],
      ['barcode', '', 'Barcode', '8901234500042'],
      [],
      [
        'Notes',
        '',
        'Fill the "Products" sheet, one product per row. If any row has an error, nothing is imported.',
      ],
      ['', '', 'When updating, blank cells keep the existing value.'],
      [
        '',
        '',
        'Box/carton prices are worked out from the base-unit price × factor unless set separately.',
      ],
    ]);

    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  async import(actor: AuthUser, file: Buffer) {
    const rows = await this.readRows(file);
    const { parsed, errors } = this.parseRows(rows);

    const tiers = await this.prisma.priceTier.findMany({
      where: { tenantId: actor.tenantId },
    });
    const tierByKey = new Map(tiers.map((t) => [tierKey(t.name), t]));
    const existing = await this.prisma.product.findMany({
      where: {
        tenantId: actor.tenantId,
        OR: [
          { sku: { in: parsed.map((p) => p.sku) } },
          { barcode: { in: parsed.flatMap((p) => p.barcode ?? []) } },
        ],
      },
      include: { units: true },
    });
    const bySku = new Map(existing.map((p) => [p.sku, p]));
    const byBarcode = new Map(existing.map((p) => [p.barcode, p]));

    // Database-dependent checks, still before anything is written.
    for (const p of parsed) {
      const rowErrors: string[] = [];
      const current = bySku.get(p.sku);
      const barcodeOwner = p.barcode ? byBarcode.get(p.barcode) : undefined;
      if (barcodeOwner && barcodeOwner.sku !== p.sku) {
        rowErrors.push(
          `barcode ${p.barcode} already belongs to product ${barcodeOwner.sku}`,
        );
      }
      for (const price of p.prices) {
        if (!tierByKey.has(price.tierKey)) {
          rowErrors.push(`price tier "${price.label}" does not exist`);
        }
      }
      if (current) {
        if (current.baseUnit !== p.baseUnit) {
          rowErrors.push(
            `baseUnit cannot change (currently "${current.baseUnit}")`,
          );
        }
        for (const [name, factor] of unitFactors(p)) {
          const unit = current.units.find((u) => u.name === name);
          if (
            unit &&
            !unit.factor.equals(factor) &&
            (await this.products.isUnitUsed(this.prisma, unit.id))
          ) {
            rowErrors.push(
              `${name}_factor cannot change from ${unit.factor.toString()}: the unit is already used in transactions`,
            );
          }
        }
      }
      if (rowErrors.length) addErrors(errors, p.row, rowErrors);
    }

    if (errors.size) {
      throw new BadRequestException({
        message:
          'Import failed. Nothing was imported: fix these rows and upload again.',
        errors: [...errors.entries()]
          .sort(([a], [b]) => a - b)
          .map(([row, list]) => ({ row, errors: list })),
      });
    }

    return this.prisma.$transaction(
      (tx) => this.write(tx, actor, parsed, bySku, tierByKey),
      { timeout: 120_000 },
    );
  }

  // ─── Writing (one transaction) ─────────────────────────────────────────────

  private async write(
    tx: Prisma.TransactionClient,
    actor: AuthUser,
    rows: ParsedRow[],
    bySku: Map<string, Prisma.ProductGetPayload<{ include: { units: true } }>>,
    tierByKey: Map<string, { id: string; name: string }>,
  ) {
    const categoryIds = await this.ensureCategories(
      tx,
      actor,
      rows.map((r) => r.category),
    );
    let created = 0;
    let updated = 0;

    for (const r of rows) {
      const categoryId = categoryIds.get(r.category.toLowerCase())!;
      const current = bySku.get(r.sku);
      let productId: string;
      let units: { id: string; name: string; factor: Decimal }[];

      if (!current) {
        const unitDefs = buildNewUnits(r);
        const product = await tx.product.create({
          data: {
            tenantId: actor.tenantId,
            sku: r.sku,
            name: r.name,
            nameNepali: r.nameNepali,
            categoryId,
            brand: r.brand,
            baseUnit: r.baseUnit,
            vatApplicable: r.vatApplicable ?? true,
            reorderLevel: r.reorderLevel ?? 0,
            barcode: r.barcode,
            units: {
              create: unitDefs.map((u) => ({ ...u, tenantId: actor.tenantId })),
            },
          },
          include: { units: true },
        });
        await this.audit.log(
          {
            tenantId: actor.tenantId,
            userId: actor.userId,
            entity: 'Product',
            entityId: product.id,
            action: AuditAction.CREATE,
            newValue: { ...product, source: 'excel-import' },
          },
          tx,
        );
        productId = product.id;
        units = product.units;
        created++;
      } else {
        // Blank cells (undefined) leave existing values unchanged.
        const after = await tx.product.update({
          where: { id: current.id },
          data: {
            name: r.name,
            nameNepali: r.nameNepali,
            categoryId,
            brand: r.brand,
            vatApplicable: r.vatApplicable,
            reorderLevel: r.reorderLevel,
            barcode: r.barcode,
          },
        });
        const { units: currentUnits, ...before } = current;
        await this.audit.log(
          {
            tenantId: actor.tenantId,
            userId: actor.userId,
            entity: 'Product',
            entityId: current.id,
            action: AuditAction.UPDATE,
            oldValue: before,
            newValue: { ...after, source: 'excel-import' },
          },
          tx,
        );
        units = await this.syncUnits(tx, actor, current.id, currentUnits, r);
        productId = current.id;
        updated++;
      }

      const baseUnit = units.find((u) => u.factor.equals(1))!;
      const priceRows: PriceRow[] = r.prices.map((p) => {
        const tier = tierByKey.get(p.tierKey)!;
        return {
          unitId: baseUnit.id,
          unitName: baseUnit.name,
          priceTierId: tier.id,
          tierName: tier.name,
          price: p.price,
        };
      });
      await this.pricing.writePrices(tx, actor, productId, priceRows);
    }
    return { created, updated };
  }

  /** Returns lowercase name -> id, creating categories that don't exist yet. */
  private async ensureCategories(
    tx: Prisma.TransactionClient,
    actor: AuthUser,
    names: string[],
  ) {
    const existing = await tx.category.findMany({
      where: { tenantId: actor.tenantId },
    });
    const ids = new Map(existing.map((c) => [c.name.toLowerCase(), c.id]));
    for (const name of names) {
      if (ids.has(name.toLowerCase())) continue;
      const category = await tx.category.create({
        data: { tenantId: actor.tenantId, name },
      });
      await this.audit.log(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          entity: 'Category',
          entityId: category.id,
          action: AuditAction.CREATE,
          newValue: { ...category, source: 'excel-import' },
        },
        tx,
      );
      ids.set(name.toLowerCase(), category.id);
    }
    return ids;
  }

  /** Adds missing box/carton units and updates their factor (already checked unused). */
  private async syncUnits(
    tx: Prisma.TransactionClient,
    actor: AuthUser,
    productId: string,
    current: { id: string; name: string; factor: Decimal }[],
    r: ParsedRow,
  ) {
    for (const [name, factor] of unitFactors(r)) {
      const unit = current.find((u) => u.name === name);
      if (unit?.factor.equals(factor)) continue;
      const after = unit
        ? await tx.productUnit.update({
            where: { id: unit.id },
            data: { factor },
          })
        : await tx.productUnit.create({
            data: { tenantId: actor.tenantId, productId, name, factor },
          });
      await this.audit.log(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          entity: 'ProductUnit',
          entityId: after.id,
          action: unit ? AuditAction.UPDATE : AuditAction.CREATE,
          oldValue: unit,
          newValue: { ...after, source: 'excel-import' },
        },
        tx,
      );
    }
    return tx.productUnit.findMany({ where: { productId } });
  }

  // ─── Reading and row validation ────────────────────────────────────────────

  private async readRows(file: Buffer) {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(file as unknown as ExcelJS.Buffer);
    } catch {
      throw new BadRequestException('The file is not a valid .xlsx workbook');
    }
    const sheet = wb.getWorksheet('Products') ?? wb.worksheets[0];
    if (!sheet) throw new BadRequestException('The workbook has no sheets');

    const columnIndex = new Map<string, number>();
    sheet.getRow(1).eachCell((cell, col) => {
      const header = String(cellValue(cell.value) ?? '').trim();
      const match = IMPORT_COLUMNS.find(
        (c) => c.toLowerCase() === header.toLowerCase(),
      );
      if (match) columnIndex.set(match, col);
    });
    const missing = REQUIRED_COLUMNS.filter((c) => !columnIndex.has(c));
    if (missing.length) {
      throw new BadRequestException(
        `Missing required columns: ${missing.join(', ')}. Download the template from /products/import/template.`,
      );
    }

    const rows: { row: number; values: Partial<Record<Column, Cell>> }[] = [];
    for (let r = 2; r <= sheet.rowCount; r++) {
      const excelRow = sheet.getRow(r);
      const values: Partial<Record<Column, Cell>> = {};
      for (const [column, col] of columnIndex) {
        const v = cellValue(excelRow.getCell(col).value);
        if (v !== null && v !== '') values[column as Column] = v;
      }
      if (Object.keys(values).length) rows.push({ row: r, values });
    }
    if (!rows.length) {
      throw new BadRequestException('The Products sheet has no data rows');
    }
    if (rows.length > MAX_ROWS) {
      throw new BadRequestException(
        `At most ${MAX_ROWS} products per file (found ${rows.length})`,
      );
    }
    return rows;
  }

  private parseRows(
    rows: { row: number; values: Partial<Record<Column, Cell>> }[],
  ) {
    const errors = new Map<number, string[]>();
    const parsed: ParsedRow[] = [];
    const skuRows = new Map<string, number>();
    const barcodeRows = new Map<string, number>();

    for (const { row, values } of rows) {
      const e: string[] = [];
      const text = (c: Column, max: number, required = false) => {
        const v = values[c];
        const s = v === undefined || v === null ? '' : String(v).trim();
        if (!s) {
          if (required) e.push(`${c} is required`);
          return undefined;
        }
        if (s.length > max) e.push(`${c} must be at most ${max} characters`);
        return s;
      };
      const num = (c: Column, decimals: number, positive: boolean) => {
        const v = values[c];
        if (v === undefined || v === null || v === '') return undefined;
        let d: Decimal;
        try {
          d = new Decimal(typeof v === 'number' ? v : String(v).trim());
        } catch {
          e.push(`${c} must be a number`);
          return undefined;
        }
        if (positive ? d.lte(0) : d.lt(0)) {
          e.push(`${c} must be ${positive ? 'greater than 0' : '0 or more'}`);
        } else if (d.decimalPlaces() > decimals) {
          e.push(`${c} can have at most ${decimals} decimal places`);
        }
        return d;
      };

      const sku = text('sku', 50, true);
      const name = text('name', 200, true);
      const category = text('category', 100, true);
      const baseUnit = text('baseUnit', 20, true)?.toLowerCase();
      const barcode = text('barcode', 50);
      if (barcode && !/^[A-Za-z0-9-]+$/.test(barcode)) {
        e.push('barcode may only contain letters, digits and -');
      }
      const boxFactor = num('box_factor', 3, true);
      const cartonFactor = num('carton_factor', 3, true);
      const prices = PRICE_COLUMNS.flatMap(({ column, tierKey, label }) => {
        const price = num(column, 2, true);
        return price ? [{ tierKey, label, price }] : [];
      });

      let vatApplicable: boolean | undefined;
      const vat = values.vatApplicable;
      if (vat !== undefined && vat !== null) {
        const s = String(vat).trim().toLowerCase();
        if (['yes', 'y', 'true', '1'].includes(s)) vatApplicable = true;
        else if (['no', 'n', 'false', '0'].includes(s)) vatApplicable = false;
        else e.push('vatApplicable must be yes or no');
      }

      if (sku) {
        const first = skuRows.get(sku);
        if (first)
          e.push(`sku ${sku} is repeated (first seen on row ${first})`);
        else skuRows.set(sku, row);
      }
      if (barcode) {
        const first = barcodeRows.get(barcode);
        if (first) {
          e.push(`barcode ${barcode} is repeated (first seen on row ${first})`);
        } else barcodeRows.set(barcode, row);
      }

      const p: ParsedRow = {
        row,
        sku: sku ?? '',
        name: name ?? '',
        nameNepali: text('nameNepali', 200),
        category: category ?? '',
        brand: text('brand', 100),
        baseUnit: baseUnit ?? '',
        boxFactor,
        cartonFactor,
        prices,
        vatApplicable,
        reorderLevel: num('reorderLevel', 3, false),
        barcode,
      };
      for (const [unitName] of unitFactors(p)) {
        if (baseUnit === unitName) {
          e.push(
            `baseUnit cannot be "${unitName}" when ${unitName}_factor is set`,
          );
        }
      }
      // Only check the unit set once the row's own fields are valid, so one
      // bad cell doesn't also produce a list of derived unit errors.
      if (!e.length) e.push(...validateUnitSet(baseUnit!, buildNewUnits(p)));

      if (e.length) addErrors(errors, row, e);
      else parsed.push(p);
    }
    return { parsed, errors };
  }
}

/** Unit set for a new product: base + optional box/carton, with sensible defaults. */
function buildNewUnits(r: ParsedRow) {
  const units = [
    { name: r.baseUnit, factor: new Decimal(1) },
    ...unitFactors(r).map(([name, factor]) => ({ name, factor })),
  ];
  const sale = r.boxFactor ? 'box' : r.baseUnit;
  const purchase = r.cartonFactor ? 'carton' : sale;
  return units.map((u) => ({
    ...u,
    isDefaultSale: u.name === sale,
    isDefaultPurchase: u.name === purchase,
  }));
}

function unitFactors(r: ParsedRow): [string, Decimal][] {
  const out: [string, Decimal][] = [];
  if (r.boxFactor) out.push(['box', r.boxFactor]);
  if (r.cartonFactor) out.push(['carton', r.cartonFactor]);
  return out;
}

function addErrors(map: Map<number, string[]>, row: number, list: string[]) {
  map.set(row, [...(map.get(row) ?? []), ...list]);
}

/** Flattens ExcelJS cell values (rich text, formulas, hyperlinks, dates) to plain values. */
function cellValue(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return null;
  if (
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean'
  ) {
    return v;
  }
  if (v instanceof Date) return v.toISOString();
  if ('richText' in v) return v.richText.map((t) => t.text).join('');
  if ('result' in v) return cellValue(v.result as ExcelJS.CellValue);
  if ('text' in v) return String(v.text);
  return null;
}
