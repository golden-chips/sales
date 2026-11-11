# GOLDEN ERP

منصة ERP سحابية متعددة المستأجرين (SaaS) لشركات التصنيع والتجارة والتوزيع — عربية أولًا.
المشغّل الأول: **شركة الرقائق الذهبية لصناعة المواد الغذائية**.

| | |
|---|---|
| `server/` | API — TypeScript, Fastify 5, PostgreSQL 16 (Row-Level Security), Vitest |
| `web/` | Web app — React 18, Vite, Arabic RTL / English LTR, dark mode |
| `docs/` | Architecture, database, audit of existing systems, benchmark, plan, security, testing results — start at [docs/README.md](docs/README.md) |

## Status — v0.1.0 (Phase 0 + Phase 1 + general-ledger core)
✅ multi-tenant platform & subscriptions · ✅ authentication (lockout, MFA, rotating sessions) · ✅ RBAC with branch scope & segregation of duties · ✅ audit trail · ✅ chart of accounts, fiscal periods, journal posting/reversal, trial balance, ledger · ✅ 52 integration tests on real PostgreSQL.
Operational modules (sales, purchasing, inventory, manufacturing, distribution, HR…) are next — see [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).

## Quick start
See [docs/INSTALLATION.md](docs/INSTALLATION.md). In short:
```bash
cd server && npm ci && cp .env.example .env   # fill values
npm run db:migrate && npm run db:seed && npm run dev
cd ../web && npm ci && npm run dev             # http://localhost:5173
cd ../server && npm test
```
