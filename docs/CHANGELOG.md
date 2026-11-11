# Changelog

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
