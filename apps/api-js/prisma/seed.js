import 'dotenv/config';
import bcrypt from 'bcrypt';
import { PrismaPg } from '@prisma/adapter-pg';
import { addDays, nepalToday } from '../src/common/dates.js';
import { MovementType, PartyType, Prisma, PrismaClient, UserRole } from '../src/generated/prisma/index.js';
import { postMovements } from '../src/stock/stock-engine.js';

const TENANT_CODE = 'DEMO';
const TENANT_NAME = 'Demo Distributors Pvt. Ltd.';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

// Tier price = retailer price per pcs × tier multiplier × unit factor × bulk-unit discount.
const TIERS = [
  { name: 'Retailer', multiplier: 1 },
  { name: 'Sub-dealer', multiplier: 0.97 },
  { name: 'Bulk', multiplier: 0.95 },
];

const UNIT_DISCOUNT = {
  pcs: 1,
  box: 0.99,
  carton: 0.98,
};

/** pcs (base) + box + carton; box is the default sale unit, carton the purchase unit. */
const units = (box, carton) => [
  { name: 'pcs', factor: 1, isDefaultSale: false, isDefaultPurchase: false },
  { name: 'box', factor: box, isDefaultSale: true, isDefaultPurchase: false },
  {
    name: 'carton',
    factor: carton,
    isDefaultSale: false,
    isDefaultPurchase: true,
  },
];

/**
 * A demo product. Non-batch products get `openingPcs` in Main Godown;
 * batch-tracked products get opening stock per batch in Main Godown, each batch
 * with a fixed `expiryDate` or `expiresInDays` from today (negative = already
 * expired), so FEFO demos stay realistic.
 */
const CORE_PRODUCTS = [
  {
    sku: 'FNB-WAIWAI-75',
    barcode: '8901234500011',
    name: 'Wai Wai Chicken Noodles 75g',
    nameNepali: 'वाइवाइ चिकेन चाउचाउ ७५ ग्राम',
    category: 'Food & Beverage',
    brand: 'Wai Wai',
    reorderLevel: 1200,
    retailPricePerPcs: 25,
    costPerPcs: 21.5,
    units: units(30, 120),
    openingPcs: 6000, // 50 cartons
  },
  {
    sku: 'FNB-COKE-250',
    barcode: '8901234500028',
    name: 'Coca-Cola 250ml Bottle',
    nameNepali: 'कोका-कोला २५० मिलि',
    category: 'Food & Beverage',
    brand: 'Coca-Cola',
    reorderLevel: 480,
    retailPricePerPcs: 50,
    costPerPcs: 42,
    units: units(6, 24),
    openingPcs: 2400, // 100 cartons
  },
  {
    sku: 'PC-LIFEBUOY-100',
    barcode: '8901234500035',
    name: 'Lifebuoy Soap 100g',
    nameNepali: 'लाइफबोय साबुन १०० ग्राम',
    category: 'Personal Care',
    brand: 'Lifebuoy',
    reorderLevel: 288,
    retailPricePerPcs: 55,
    costPerPcs: 46.25,
    units: units(12, 144),
    batches: [
      {
        batchNo: 'LB-2083-01',
        mfgDate: '2026-08-01',
        expiryDate: '2028-07-31',
        qty: 1440, // 10 cartons
      },
    ],
  },
];

// Batch-tracked products with staggered expiries for testing FEFO, the
// expiring-stock report and the "expired batches are skipped" rule.
const FEFO_PRODUCTS = [
  {
    sku: 'PC-DETTOL-125',
    barcode: '8901234500059',
    name: 'Dettol Antiseptic Liquid 125ml',
    nameNepali: 'डेटोल एन्टिसेप्टिक १२५ मिलि',
    category: 'Personal Care',
    brand: 'Dettol',
    reorderLevel: 96,
    retailPricePerPcs: 115,
    costPerPcs: 96,
    units: units(12, 48),
    batches: [
      { batchNo: 'DT-EXP', expiresInDays: -10, qty: 24 }, // already expired
      { batchNo: 'DT-A', expiresInDays: 20, qty: 48 },
      { batchNo: 'DT-B', expiresInDays: 120, qty: 96 },
      { batchNo: 'DT-C', expiresInDays: 400, qty: 144 },
    ],
  },
  {
    sku: 'FNB-HORLICKS-500',
    barcode: '8901234500066',
    name: 'Horlicks Classic Malt 500g Jar',
    nameNepali: 'होर्लिक्स ५०० ग्राम',
    category: 'Food & Beverage',
    brand: 'Horlicks',
    reorderLevel: 96, // stock 72 -> shows in the low-stock report
    retailPricePerPcs: 520,
    costPerPcs: 455,
    units: units(6, 24),
    batches: [
      { batchNo: 'HL-A', expiresInDays: 45, qty: 24 },
      { batchNo: 'HL-B', expiresInDays: 300, qty: 48 },
    ],
  },
  {
    sku: 'PC-COLGATE-100',
    barcode: '8901234500073',
    name: 'Colgate Strong Teeth 100g',
    nameNepali: 'कोलगेट १०० ग्राम',
    category: 'Personal Care',
    brand: 'Colgate',
    reorderLevel: 144,
    retailPricePerPcs: 95,
    costPerPcs: 80,
    units: units(12, 144),
    batches: [
      { batchNo: 'CG-A', expiresInDays: 8, qty: 60 }, // expiring this week
      { batchNo: 'CG-B', expiresInDays: 200, qty: 288 },
    ],
  },
];

async function createProduct(tx, ctx, p) {
  const { tenantId } = ctx;
  const product = await tx.product.create({
    data: {
      tenantId,
      sku: p.sku,
      barcode: p.barcode,
      name: p.name,
      nameNepali: p.nameNepali,
      categoryId: await ctx.categoryId(p.category),
      brand: p.brand,
      baseUnit: 'pcs',
      trackBatch: !!p.batches,
      reorderLevel: p.reorderLevel,
    },
  });

  for (const u of p.units) {
    const unit = await tx.productUnit.create({
      data: { tenantId, productId: product.id, ...u },
    });
    for (const tier of ctx.tiers) {
      const price =
        p.retailPricePerPcs *
        tier.multiplier *
        u.factor *
        UNIT_DISCOUNT[u.name];
      await tx.productPrice.create({
        data: {
          tenantId,
          productId: product.id,
          unitId: unit.id,
          priceTierId: tier.id,
          price: price.toFixed(2),
        },
      });
    }
  }

  const opening = {
    tenantId,
    godownId: ctx.godownId,
    productId: product.id,
    type: MovementType.OPENING,
    unitCost: new Prisma.Decimal(p.costPerPcs),
    refType: 'OPENING',
    refId: product.id,
    createdById: ctx.ownerId,
  };
  const movements = [];
  if (p.openingPcs) {
    movements.push({ ...opening, quantity: new Prisma.Decimal(p.openingPcs) });
  }
  for (const b of p.batches ?? []) {
    const expiry =
      b.expiresInDays !== undefined
        ? addDays(nepalToday(), b.expiresInDays)
        : new Date(`${b.expiryDate}T00:00:00Z`);
    const batch = await tx.batch.create({
      data: {
        tenantId,
        productId: product.id,
        batchNo: b.batchNo,
        mfgDate: b.mfgDate ? new Date(`${b.mfgDate}T00:00:00Z`) : null,
        expiryDate: expiry,
        costPrice: p.costPerPcs,
      },
    });
    movements.push({
      ...opening,
      batchId: batch.id,
      quantity: new Prisma.Decimal(b.qty),
    });
  }
  // Opening stock goes through the stock engine like every other movement.
  await postMovements(tx, movements);
}

async function seedCore() {
  const [ownerHash, salesmanHash] = await Promise.all([
    bcrypt.hash('admin123', 10),
    bcrypt.hash('sales123', 10),
  ]);

  await prisma.$transaction(
    async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          code: TENANT_CODE,
          name: TENANT_NAME,
          panVatNo: '600000001',
          address: 'Kalimati, Kathmandu',
          phone: '01-4270000',
        },
      });
      const tenantId = tenant.id;

      const owner = await tx.user.create({
        data: {
          tenantId,
          name: 'Demo Owner',
          phone: '9800000000',
          email: 'owner@demo.godamo.local',
          passwordHash: ownerHash,
          role: UserRole.OWNER,
        },
      });
      const salesman = await tx.user.create({
        data: {
          tenantId,
          name: 'Ram Salesman',
          phone: '9800000001',
          passwordHash: salesmanHash,
          role: UserRole.SALESMAN,
        },
      });

      const mainGodown = await tx.godown.create({
        data: { tenantId, name: 'Main Godown', address: 'Kalimati, Kathmandu' },
      });
      await tx.godown.create({
        data: { tenantId, name: 'Second Godown', address: 'Balkhu, Kathmandu' },
      });

      const tiers = {};
      for (const t of TIERS) {
        const tier = await tx.priceTier.create({
          data: { tenantId, name: t.name },
        });
        tiers[t.name] = { id: tier.id, multiplier: t.multiplier };
      }

      const ctx = await buildContext(tx, tenantId, owner.id, mainGodown.id);
      for (const p of CORE_PRODUCTS) await createProduct(tx, ctx, p);

      const beat = await tx.beat.create({
        data: {
          tenantId,
          name: 'Kalimati - Kuleshwor',
          dayOfWeek: 0,
          salesmanId: salesman.id,
        },
      });

      await tx.party.createMany({
        data: [
          {
            tenantId,
            type: PartyType.CUSTOMER,
            name: 'Shrestha Kirana Pasal',
            ownerName: 'Hari Shrestha',
            phone: '9841000001',
            address: 'Kuleshwor, Kathmandu',
            priceTierId: tiers['Retailer'].id,
            creditLimit: 50000,
            creditDays: 15,
            beatId: beat.id,
          },
          {
            tenantId,
            type: PartyType.CUSTOMER,
            name: 'Gurung General Store',
            ownerName: 'Sita Gurung',
            phone: '9841000002',
            panVatNo: '600000102',
            address: 'Kalimati, Kathmandu',
            priceTierId: tiers['Sub-dealer'].id,
            creditLimit: 200000,
            creditDays: 30,
            beatId: beat.id,
          },
          {
            tenantId,
            type: PartyType.CUSTOMER,
            name: 'Valley Wholesale Mart',
            ownerName: 'Bikash Maharjan',
            phone: '9841000003',
            panVatNo: '600000103',
            address: 'Balkhu, Kathmandu',
            priceTierId: tiers['Bulk'].id,
            creditLimit: 500000,
            creditDays: 45,
          },
          {
            tenantId,
            type: PartyType.SUPPLIER,
            name: 'Himalayan FMCG Suppliers',
            ownerName: 'Prakash Joshi',
            phone: '9851000010',
            panVatNo: '600000200',
            address: 'Birgunj, Parsa',
            creditDays: 30,
          },
        ],
      });

      console.log(`Seeded tenant "${TENANT_NAME}" (${tenantId}).`);
    },
    { timeout: 60_000 },
  );
}

/** Adds any FEFO demo product that doesn't exist yet (safe to re-run). */
async function seedBatchProducts(tenantId) {
  await prisma.$transaction(
    async (tx) => {
      const [owner, godown] = await Promise.all([
        tx.user.findFirstOrThrow({
          where: { tenantId, role: UserRole.OWNER },
          orderBy: { createdAt: 'asc' },
        }),
        tx.godown.findFirstOrThrow({
          where: { tenantId, name: 'Main Godown' },
        }),
      ]);
      const ctx = await buildContext(tx, tenantId, owner.id, godown.id);
      for (const p of FEFO_PRODUCTS) {
        const exists = await tx.product.findFirst({
          where: { tenantId, sku: p.sku },
        });
        if (exists) continue;
        await createProduct(tx, ctx, p);
        console.log(
          `Added batch-tracked product ${p.sku} (${p.batches .length} batches).`,
        );
      }
    },
    { timeout: 60_000 },
  );
}

async function buildContext(tx, tenantId, ownerId, godownId) {
  const tierRows = await tx.priceTier.findMany({ where: { tenantId } });
  const tiers = TIERS.flatMap((t) => {
    const row = tierRows.find((r) => r.name === t.name);
    return row ? [{ id: row.id, multiplier: t.multiplier }] : [];
  });
  const categoryId = async (name) => {
    const existing = await tx.category.findFirst({ where: { tenantId, name } });
    return (
      existing ?? (await tx.category.create({ data: { tenantId, name } }))
    ).id;
  };
  return { tenantId, ownerId, godownId, tiers, categoryId };
}

async function main() {
  let tenant = await prisma.tenant.findUnique({ where: { code: TENANT_CODE } });
  if (tenant) {
    console.log(`Core seed skipped: tenant ${TENANT_CODE} already exists.`);
  } else {
    await seedCore();
    tenant = await prisma.tenant.findUniqueOrThrow({
      where: { code: TENANT_CODE },
    });
  }
  await seedBatchProducts(tenant.id);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
