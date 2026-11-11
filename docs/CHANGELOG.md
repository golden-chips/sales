# Changelog

## 0.3.0 — 2026-11-11 — Phase 3: manufacturing & quality
### Added
- Migration 006: versioned formulas (approval with SoD, frozen once approved, one approved version per product, approved substitutes), work centers, production orders and entries, quality specs with HACCP CCPs, checks and results (append-only), non-conformance with CAPA, recalls, lot hold.
- Actual costing through WIP (issue / return / line hours / completion into quarantine), standard cost roll-up frozen at release, cost report (yield, quantity and cost variances), material availability, MRP with purchase suggestions.
- Quality gates: system-judged results, failure → lot hold + NCR, release only after a passed check, recall holds every derived lot and survives re-tests; backward/forward genealogy through production.
- Web: formulas, production orders (issue, hours, complete, cost), MRP, quality checks, specs & HACCP, non-conformance, trace & recall. Demo manufacturing data for `demo-foods`.
- 9 new integration tests (78 total).
### Fixed
- Stock values were rounded to 4 decimals while the GL rounds to the currency (LYD = 3): the stock subledger could drift from the GL by fractions of a dirham. All stock values now use the currency's minor units.
- Production managers could have recorded QC on their own output (removed: inspection belongs to Quality).

## 0.2.0 — 2026-11-11 — Phase 2b: core ERP
### Added
- Migration 005: customers/suppliers, items with unit conversions, lots with production/expiry dates, perpetual inventory (weighted average, append-only stock ledger with per-line traceability, non-negative balances), sales invoices, sales returns, goods receipts, supplier invoices, payments with allocations, stock documents (opening, count, damage, transfer, quarantine release); 25 new permissions.
- Posting engine: every document draft → posted in one transaction with its journal entry through the GL source contract; segregation of duties; idempotent posting.
- Business rules: FEFO allocation excluding expired lots, expired lots unsellable, returns forced into quarantine and into the original lots, quarantine release reserved for Quality, credit limit at posting, FIFO receipt allocation with customer advances, supplier invoice cannot exceed received value.
- Reports: stock with lots/expiry, item card, lot trace to customers, stock-vs-GL reconciliation, AR aging, customer statement, sales margin analysis.
- Web: items, customers, suppliers, stock on hand + lot trace, sales invoices (carton/bag units, discounts), returns, customer receipts, AR aging, goods receipts, supplier invoices, stock documents.
- DEMO master data and opening stock for tenant `demo-foods`; `npm run roles:sync`.
- 17 new integration tests (69 total).
### Fixed
- Expired lots could be picked by FEFO for a sale (found in browser testing).
- Warehouse-manager role could release quarantined goods (now Quality only).
- Lot trace reported 0 returned quantity.
- Account-role cache bound to pooled DB connections could serve stale accounts across requests (cache removed).

## 0.1.0 — 2026-11-11 — Phase 0 + Phase 1 (+ GL core)
### Added
- Phase 0 discovery & audit of the van-sales and HR/attendance systems; competitive benchmark; architecture; risks & decisions.
- PostgreSQL schema (4 migrations): platform (plans, tenants, subscriptions, invoices, coupons), tenant org (companies, branches, warehouses), IAM (users, roles, permissions, sessions, login attempts), append-only audit log, idempotency keys, document sequences, general ledger (accounts, cost centers, fiscal years/periods, FX rates, journal entries/lines) with integrity triggers and FORCE RLS.
- API (Fastify, 62 operations, OpenAPI at `/api/docs`, exported to `docs/api/openapi.json`).
- Web app (React, Arabic RTL first, English, dark mode, responsive): login, dashboard, users, roles, organization, chart of accounts, journal entries, trial balance & ledger drill-down, fiscal periods, audit log, subscription, platform console.
- Seed: platform admin, 5 plans, tenant `golden-chips`, DEMO tenant.
- 52 integration tests on real PostgreSQL; CI workflow.
