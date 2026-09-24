import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AccountsCoreModule } from './accounts/accounts-core.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CategoriesModule } from './categories/categories.module.js';
import { CreditModule } from './credit/credit.module.js';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard.js';
import { RolesGuard } from './common/guards/roles.guard.js';
import { validateEnv } from './config/env.validation.js';
import { HealthController } from './health/health.controller.js';
import { GodownsModule } from './godowns/godowns.module.js';
import { HandoversModule } from './handovers/handovers.module.js';
import { InvoicesModule } from './invoices/invoices.module.js';
import { PartiesModule } from './parties/parties.module.js';
import { PartyAccountsModule } from './party-accounts/party-accounts.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { PricingModule } from './pricing/pricing.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ProductsModule } from './products/products.module.js';
import { PurchasesModule } from './purchases/purchases.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { SalesOrdersModule } from './sales-orders/sales-orders.module.js';
import { StockModule } from './stock/stock.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    // Only applied where ThrottlerGuard is used (currently POST /auth/login).
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 5 }]),
    PrismaModule,
    AuditModule,
    AuthModule,
    UsersModule,
    CategoriesModule,
    PricingModule,
    ProductsModule,
    PartiesModule,
    GodownsModule,
    StockModule,
    PurchasesModule,
    CreditModule,
    SalesOrdersModule,
    InvoicesModule,
    AccountsCoreModule,
    PaymentsModule,
    HandoversModule,
    PartyAccountsModule,
    ReportsModule,
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: authenticate first, then check roles.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
