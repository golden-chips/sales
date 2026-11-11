# Software Architecture Document — GOLDEN ERP

## 1. Decision summary

| Concern | Decision | Why (and what was rejected) |
|---|---|---|
| Style | **Modular monolith** (one deployable API, strict module folders) | Microservices would add distributed-transaction problems exactly where an ERP needs atomicity (invoice + stock + journal in one transaction). Modules talk through service functions, not shared tables, so each can be split out later. |
| Language / runtime | **TypeScript on Node.js 22** | Same language as both existing systems (React, Cloud Functions) → the team and the existing business logic transfer directly. |
| HTTP framework | **Fastify 5** | Mature, fast, first-class schema/OpenAPI support, low overhead. |
| Database | **PostgreSQL 16** | Real relational integrity (FKs, CHECKs, deferred constraints, exclusion constraints), `numeric` exact money, transactions, **Row-Level Security**. Firestore (current) cannot enforce double entry or cross-document integrity. |
| Tenancy | **Shared database, shared schema, `tenant_id` + FORCE RLS** | See §3. |
| Validation | **zod** (single source of truth, called in every handler) | Route JSON schemas exist only for OpenAPI docs. |
| Auth | JWT access token (15 min, HS256) + opaque rotating refresh token (hashed in DB, family revocation on reuse) + TOTP MFA | Stateless request auth, immediate revocation via refresh family + per-request permission load. |
| Frontend | **React 18 + Vite + TypeScript**, no UI framework, CSS tokens | Same stack as the existing admin panel; RTL handled with logical CSS properties. |
| Tests | **Vitest** against a **real PostgreSQL** database as the non-superuser runtime role | Mocked databases would not prove RLS or triggers work. |

## 2. Layers

```
web (React, RTL/LTR)  ──HTTPS/JSON──▶  API (Fastify)
                                        ├─ core/      auth, RBAC guard (can()), errors, idempotency, audit, plan limits
                                        ├─ modules/
                                        │   ├─ platform/   plans, tenants, subscriptions, billing (platform scope)
                                        │   ├─ auth/       login, refresh, MFA, password
                                        │   ├─ iam/        users, roles, permissions
                                        │   ├─ org/        companies, branches, warehouses, settings, subscription view
                                        │   ├─ audit/      audit trail query
                                        │   └─ accounting/ CoA, periods, journal, FX, reports
                                        └─ db/pool.ts  tx(ctx) — binds tenant/user/platform context per transaction
                                                         │
                                                PostgreSQL 16 (role golden_app, NOBYPASSRLS)
                                                RLS policies · triggers · constraints
```

Every request: `can(permission)` preHandler → verifies JWT → loads the user's **current** permissions, branch scope and plan modules inside a tenant-scoped transaction → checks module-in-plan (402) and permission (403) → handler runs inside `withTenant()`.

## 3. Multi-tenancy — options studied

| Strategy | Isolation | Cost / ops | Cross-tenant platform reporting | Verdict |
|---|---|---|---|---|
| Database per tenant | Strongest | One DB + migrations + backups per customer; expensive at hundreds of tenants | Hard | Offer later as an **Enterprise add-on** (dedicated instance) |
| Schema per tenant | Strong | Migrations × N schemas; catalog bloat at scale | Medium | Rejected |
| **Shared schema + RLS** | Strong *if enforced by the DB* | One migration, one backup, pooling-friendly | Easy (counts via SECURITY DEFINER functions) | **Chosen** |

How isolation is enforced (all covered by tests in `server/test/tenant-isolation.test.ts`):
1. Every tenant-owned table has `tenant_id` and `ENABLE` + **`FORCE ROW LEVEL SECURITY`** with `USING/WITH CHECK (tenant_id = app_tenant_id())`.
2. The app connects as `golden_app` — `NOSUPERUSER NOBYPASSRLS`. The server refuses to start in production if the role bypasses RLS.
3. Context is set with `set_config(..., true)` — **transaction-local**, so a pooled connection can never leak one tenant's context to the next request.
4. **Composite foreign keys** `(tenant_id, x_id) → parent(tenant_id, id)` make it impossible to reference another tenant's row even inside a valid context.
5. Platform staff run with `app.is_platform = on`; they see tenants/subscriptions/invoices but **zero** tenant business rows. Usage metering goes through `platform_tenant_usage()` which returns counts only.
6. Tenant code → id resolution before login uses `resolve_tenant()` (SECURITY DEFINER, returns id/status only).

## 4. Cross-module integration contract

Business modules never write `journal_entries` directly. They call:

```ts
postFromSource(db, user, { companyId, entryDate, memo, sourceType: "sales_invoice", sourceId: invoice.id, lines })
```

* Runs in the **same transaction** as the source document (invoice + stock move + journal commit or roll back together).
* **Idempotent**: unique index `(company_id, source_type, source_id)` — a retried or double-clicked approval returns the existing entry.
* Accounts are looked up by **role** (`ar`, `sales_revenue`, `inventory_fg`, `cogs`, …) defined on the chart of accounts, not by hard-coded codes, so each tenant keeps its own numbering.
* Corrections: `reverseEntry()` (documented reversal), never update/delete.

## 5. Cross-cutting

| Concern | Now (Phase 1) | Planned |
|---|---|---|
| Audit | `audit_log` append-only (trigger + revoked UPDATE/DELETE), written in the same transaction as the change, secrets scrubbed | Hash chaining for tamper evidence |
| Idempotency | `Idempotency-Key` header with advisory lock + stored response | Required on all mobile sync endpoints |
| Rate limiting | Global per-IP + strict login limit (`@fastify/rate-limit`) | Per-tenant limit from `plans.api_rpm` (Redis store for multi-instance) |
| Background jobs | `sweepSubscriptions()` callable via platform endpoint | Job runner (pg-boss on PostgreSQL — no extra infrastructure) for sweeps, reports, notifications |
| Notifications | — | Reuse existing WhatsApp Meta integration as a notification service |
| File storage | — | S3-compatible object storage, tenant-prefixed keys, signed URLs |
| Search | PostgreSQL `ILIKE` + indexes | `pg_trgm` / full-text; dedicated engine only if needed |
| Caching | none (permissions loaded per request on purpose) | Short-TTL cache for plan/permissions if load requires |
| Monitoring | structured JSON logs (pino), request id on every response | OpenTelemetry traces + metrics, uptime checks |
| CI/CD | — | GitHub Actions: typecheck + tests on PostgreSQL service container + web build |
| Backups | see `INSTALLATION.md` | PITR (WAL archiving) + encrypted off-site + **tested restore** drills |

## 6. AI (future) — guard rails by design

AI features will be **read-only advisors** running with the requesting user's permissions (same RLS context). Any action they propose (journal, payment, purchase order) is created as a **draft** that a human with the right permission must approve and post — the same SoD rules apply.
