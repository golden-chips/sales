# Changelog

## 0.1.0 — 2026-11-11 — Phase 0 + Phase 1 (+ GL core)
### Added
- Phase 0 discovery & audit of the van-sales and HR/attendance systems; competitive benchmark; architecture; risks & decisions.
- PostgreSQL schema (4 migrations): platform (plans, tenants, subscriptions, invoices, coupons), tenant org (companies, branches, warehouses), IAM (users, roles, permissions, sessions, login attempts), append-only audit log, idempotency keys, document sequences, general ledger (accounts, cost centers, fiscal years/periods, FX rates, journal entries/lines) with integrity triggers and FORCE RLS.
- API (Fastify, 62 operations, OpenAPI at `/api/docs`, exported to `docs/api/openapi.json`).
- Web app (React, Arabic RTL first, English, dark mode, responsive): login, dashboard, users, roles, organization, chart of accounts, journal entries, trial balance & ledger drill-down, fiscal periods, audit log, subscription, platform console.
- Seed: platform admin, 5 plans, tenant `golden-chips`, DEMO tenant.
- 52 integration tests on real PostgreSQL; CI workflow.
