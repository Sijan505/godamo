# Godamo — Project Context

This document is the shared reference for all future work on Godamo. Read this
before starting any new feature or prompt so decisions stay consistent with
the product's core rules.

## Product

Godamo is a multi-tenant SaaS platform for wholesalers and distributors in
Nepal, built by Cezvora Technology.

## Apps

- **Office web app** — used by owners, managers, and office staff to run the
  day-to-day business (Next.js).
- **Field app** — used by salesmen and drivers for order booking, deliveries,
  and collections (Flutter, Android first).
- **Owner app** (later) — a lightweight app for owners to monitor the
  business remotely.
- **Retailer ordering app** (later) — lets retailers place orders directly.

## Users / Roles

- Owner
- Manager
- Office staff (billing / accounts)
- Godown staff
- Salesman
- Driver

## Core Business Flow

```
setup -> purchase -> godown stock -> order booking -> billing ->
dispatch -> collection -> reports
```

## Core Rules

1. **Stock is never stored as a single number.** Stock is always the sum of
   stock movements (purchase, sale, return, transfer, adjustment, damage).
2. **Products have multiple units with conversion** (e.g. 1 carton = 12 box,
   1 box = 12 pcs). Stock is stored internally in the smallest unit.
3. **Party-wise pricing.** Price tiers exist per party type (retailer,
   sub-dealer, bulk), plus special prices can be set per individual party.
4. **Every party has a ledger.** The balance is always calculated
   (bills - payments - returns), never stored as a static field.
5. **Credit control.** Each party has a credit limit and credit days.
   Billing above the credit limit requires owner approval.
6. **Money and stock rows are append-only.** Corrections are made with
   reversal rows, never by editing or deleting existing rows.
7. **Every money or stock action runs inside one database transaction.**
8. **Every table has a `tenant_id`** for multi-tenant isolation.
9. **Every change is written to an audit log.**
10. **Batch and expiry tracking** with first-expiry-first-out (FEFO) picking.
11. **`tenantId` always comes from the access token**, never from the request
    body, params or query. Read it with `@CurrentUser()` and filter every
    query by it. A record id that belongs to another tenant must behave as if
    it does not exist (404).
12. **The server ALWAYS calculates prices, VAT and totals.** Clients send only
    what is sold (product, unit, quantity, discount %); rates come from
    `PricingService` and amounts from the shared bill maths. Never trust
    prices or totals sent by a client.

## API Conventions (apps/api)

- Every route requires a valid access token unless marked `@Public()`.
- Restrict routes by role with `@Roles(...)`.
- Write an audit row with `AuditService.log(...)` inside the same transaction
  as the change it records. Never put passwords or tokens in audit values.
- **`StockService` (`apps/api/src/stock/stock.service.ts`) is the ONLY code
  allowed to create `StockMovement` rows.** Call `postMovements(tx, …)` inside
  the caller's transaction; it takes a PostgreSQL advisory lock per
  godown + product before any stock-out and refuses negative stock. Pick
  batches with `allocateFEFO(…)` and undo documents with
  `reverseMovements(…)`. Never insert, update or delete movements directly.
- All API routes are under `/api/v1` (e.g. `http://localhost:4000/api/v1/auth/login`).
- API docs: `http://localhost:4000/api/docs`.

## Nepal-Specific Requirements

- VAT at 13%
- IRD-compliant invoices
  - Invoices are never deleted; cancelling keeps the number. Numbers are
    gap-free per tenant and fiscal year (starts Shrawan 1, e.g. "2083/84").
  - First print is the original; later prints say "COPY OF ORIGINAL - Print #n".
  - **TODO before production:** verify every invoice field, the PDF layout,
    the cancellation/credit-note flow and real-time sync with the IRD Central
    Billing Monitoring System (CBMS) against the current IRD billing-software
    rules, and get the software approved.
- Both BS (Bikram Sambat) and AD (Gregorian) dates supported
  - AD <-> BS uses `nepali-date-converter`, whose data ends at BS 2090
    (~2034 AD); update or replace it before then.
- Nepali and English language support
- Payment methods: cash, cheque, bank transfer, Fonepay, eSewa, Khalti

## Field App Notes

The field app is **offline-first** and syncs later. Every action generated
offline carries a unique `client_uuid` to prevent duplicate records when it
eventually syncs with the server.
