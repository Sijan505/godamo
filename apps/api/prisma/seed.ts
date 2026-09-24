import 'dotenv/config';
import bcrypt from 'bcrypt';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  MovementType,
  PartyType,
  PrismaClient,
  UserRole,
} from '../src/generated/prisma/client.js';

const TENANT_CODE = 'DEMO';
const TENANT_NAME = 'Demo Distributors Pvt. Ltd.';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

// Tier price = retailer price per pcs × tier multiplier × unit factor × bulk-unit discount.
const TIERS = [
  { name: 'Retailer', multiplier: 1 },
  { name: 'Sub-dealer', multiplier: 0.97 },
  { name: 'Bulk', multiplier: 0.95 },
] as const;

const UNIT_DISCOUNT: Record<string, number> = {
  pcs: 1,
  box: 0.99,
  carton: 0.98,
};

const PRODUCTS = [
  {
    sku: 'FNB-WAIWAI-75',
    barcode: '8901234500011',
    name: 'Wai Wai Chicken Noodles 75g',
    nameNepali: 'वाइवाइ चिकेन चाउचाउ ७५ ग्राम',
    category: 'Food & Beverage',
    brand: 'Wai Wai',
    trackBatch: false,
    reorderLevel: 1200, // pcs
    retailPricePerPcs: 25,
    costPerPcs: 21.5,
    units: [
      {
        name: 'pcs',
        factor: 1,
        isDefaultSale: false,
        isDefaultPurchase: false,
      },
      {
        name: 'box',
        factor: 30,
        isDefaultSale: true,
        isDefaultPurchase: false,
      },
      {
        name: 'carton',
        factor: 120,
        isDefaultSale: false,
        isDefaultPurchase: true,
      },
    ],
    openingPcs: 6000, // 50 cartons
  },
  {
    sku: 'FNB-COKE-250',
    barcode: '8901234500028',
    name: 'Coca-Cola 250ml Bottle',
    nameNepali: 'कोका-कोला २५० मिलि',
    category: 'Food & Beverage',
    brand: 'Coca-Cola',
    trackBatch: false,
    reorderLevel: 480,
    retailPricePerPcs: 50,
    costPerPcs: 42,
    units: [
      {
        name: 'pcs',
        factor: 1,
        isDefaultSale: false,
        isDefaultPurchase: false,
      },
      { name: 'box', factor: 6, isDefaultSale: true, isDefaultPurchase: false },
      {
        name: 'carton',
        factor: 24,
        isDefaultSale: false,
        isDefaultPurchase: true,
      },
    ],
    openingPcs: 2400, // 100 cartons
  },
  {
    sku: 'PC-LIFEBUOY-100',
    barcode: '8901234500035',
    name: 'Lifebuoy Soap 100g',
    nameNepali: 'लाइफबोय साबुन १०० ग्राम',
    category: 'Personal Care',
    brand: 'Lifebuoy',
    trackBatch: true,
    reorderLevel: 288,
    retailPricePerPcs: 55,
    costPerPcs: 46.25,
    units: [
      {
        name: 'pcs',
        factor: 1,
        isDefaultSale: false,
        isDefaultPurchase: false,
      },
      {
        name: 'box',
        factor: 12,
        isDefaultSale: true,
        isDefaultPurchase: false,
      },
      {
        name: 'carton',
        factor: 144,
        isDefaultSale: false,
        isDefaultPurchase: true,
      },
    ],
    openingPcs: 1440, // 10 cartons
    batch: {
      batchNo: 'LB-2083-01',
      mfgDate: '2026-08-01',
      expiryDate: '2028-07-31',
    },
  },
];

async function main() {
  const existing = await prisma.tenant.findUnique({
    where: { code: TENANT_CODE },
  });
  if (existing) {
    console.log(
      `Seed skipped: tenant ${TENANT_CODE} already exists (${existing.id}).`,
    );
    return;
  }

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

      const tiers: Record<string, { id: string; multiplier: number }> = {};
      for (const t of TIERS) {
        const tier = await tx.priceTier.create({
          data: { tenantId, name: t.name },
        });
        tiers[t.name] = { id: tier.id, multiplier: t.multiplier };
      }

      const categories: Record<string, string> = {};
      for (const name of new Set(PRODUCTS.map((p) => p.category))) {
        const category = await tx.category.create({ data: { tenantId, name } });
        categories[name] = category.id;
      }

      for (const p of PRODUCTS) {
        const product = await tx.product.create({
          data: {
            tenantId,
            sku: p.sku,
            barcode: p.barcode,
            name: p.name,
            nameNepali: p.nameNepali,
            categoryId: categories[p.category],
            brand: p.brand,
            baseUnit: 'pcs',
            trackBatch: p.trackBatch,
            reorderLevel: p.reorderLevel,
          },
        });

        for (const u of p.units) {
          const unit = await tx.productUnit.create({
            data: { tenantId, productId: product.id, ...u },
          });
          for (const tier of Object.values(tiers)) {
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

        const batch = p.batch
          ? await tx.batch.create({
              data: {
                tenantId,
                productId: product.id,
                batchNo: p.batch.batchNo,
                mfgDate: new Date(p.batch.mfgDate),
                expiryDate: new Date(p.batch.expiryDate),
                costPrice: p.costPerPcs,
              },
            })
          : null;

        await tx.stockMovement.create({
          data: {
            tenantId,
            godownId: mainGodown.id,
            productId: product.id,
            batchId: batch?.id,
            type: MovementType.OPENING,
            quantity: p.openingPcs,
            unitCost: p.costPerPcs,
            refType: 'OPENING',
            refId: product.id,
            createdById: owner.id,
          },
        });
      }

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

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
