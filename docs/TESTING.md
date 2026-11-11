# Testing Strategy & Results

## Strategy

| Level | Tooling | Status |
|---|---|---|
| Unit | Vitest | Pure helpers are covered through integration tests for now; dedicated unit tests come with Phase 2b costing logic |
| **Integration (API + DB)** | Vitest + Fastify `inject` + **real PostgreSQL 16**, connecting as the non-superuser `golden_app` role | **92 tests, all passing** (see results; one open intermittent issue K12) |
| Security | RLS isolation, forged tokens, privilege escalation, SoD, lockout, refresh-token reuse, MFA | Included in the 52 |
| Accounting | balance, immutability (also by bypassing the service layer), reversal, closed periods, FX rounding, idempotency, trial-balance/ledger/statement reconciliation | Included |
| SaaS | plan limits, downgrade guard, suspend/reactivate, trial → past_due → suspended sweep | Included |
| End-to-end (browser) | Playwright script driving the real web app + API (owner login → create accountant → create entry → SoD block → accountant posts → trial balance → ledger → English/dark → platform console → mobile viewport) | Run manually (see results); to be added to CI |
| Performance | k6 / autocannon | **Not run yet** — planned before go-live with targets in `IMPLEMENTATION_PLAN.md` |
| Regression | Full suite on every push (`.github/workflows/ci.yml`) | CI workflow added; first CI run happens on push |

Rules: tests never use production data (each test provisions its own throw-away tenant); the test database is rebuilt from migrations on every run (`scripts/reset-db.ts` refuses to touch a database whose name does not end in `_test`/`_dev`).

Run locally:
```bash
cd server && npm test        # needs PostgreSQL; see INSTALLATION.md
```

## Results — 2026-11-11 (local run, PostgreSQL 16.15, Node 22.23)

```
✓ test/rbac-saas.test.ts > RBAC > seeds all 16 tenant system roles
✓ test/rbac-saas.test.ts > RBAC > read-only user can view but not create
✓ test/rbac-saas.test.ts > RBAC > permission revocation is effective immediately (no re-login)
✓ test/rbac-saas.test.ts > RBAC > deactivated user is rejected on next request
✓ test/rbac-saas.test.ts > RBAC > prevents privilege escalation: a company admin cannot assign finance roles they don't hold
✓ test/rbac-saas.test.ts > RBAC > branch-scoped user sees only their branch
✓ test/rbac-saas.test.ts > RBAC > module not in plan returns 402
✓ test/rbac-saas.test.ts > RBAC > quarantine warehouses can never be sellable (DB constraint)
✓ test/rbac-saas.test.ts > SaaS plans, limits and lifecycle > enforces the plan user limit
✓ test/rbac-saas.test.ts > SaaS plans, limits and lifecycle > enforces branch limit
✓ test/rbac-saas.test.ts > SaaS plans, limits and lifecycle > blocks a downgrade that exceeds the target plan's limits, allows upgrade
✓ test/rbac-saas.test.ts > SaaS plans, limits and lifecycle > suspension blocks login and API immediately; reactivation restores
✓ test/rbac-saas.test.ts > SaaS plans, limits and lifecycle > lifecycle sweep: trial end → past_due (still usable) → suspended after grace
✓ test/rbac-saas.test.ts > SaaS plans, limits and lifecycle > tenant sees its own subscription, limits and usage
✓ test/rbac-saas.test.ts > SaaS plans, limits and lifecycle > tenant code must be unique
✓ test/auth.test.ts > authentication > rejects wrong password and unknown tenant with the same generic error
✓ test/auth.test.ts > authentication > records login attempts
✓ test/auth.test.ts > authentication > locks the account after max failed logins, admin can unlock
✓ test/auth.test.ts > authentication > rotates refresh tokens and revokes the family on reuse
✓ test/auth.test.ts > authentication > MFA: enrol, then login requires a valid TOTP
✓ test/auth.test.ts > authentication > enforces password policy on change
✓ test/auth.test.ts > authentication > me returns permissions and plan modules
✓ test/auth.test.ts > authentication > rejects missing / garbage tokens
✓ test/accounting.test.ts > general ledger > seeded CoA has headers, leaves, contra accounts and roles
✓ test/accounting.test.ts > general ledger > fiscal year generates 12 contiguous monthly periods
✓ test/accounting.test.ts > general ledger > overlapping fiscal year is rejected
✓ test/accounting.test.ts > general ledger > rejects a line with both debit and credit
✓ test/accounting.test.ts > general ledger > an unbalanced draft can be saved but never posted
✓ test/accounting.test.ts > general ledger > database rejects posting an unbalanced entry even if the service check is bypassed
✓ test/accounting.test.ts > general ledger > segregation of duties: creator cannot post own entry; another accountant can
✓ test/accounting.test.ts > general ledger > posted entries and their lines are immutable at the database level
✓ test/accounting.test.ts > general ledger > reversal creates a mirrored posted entry and nets to zero; cannot reverse twice
✓ test/accounting.test.ts > general ledger > accountant (without reverse permission) cannot reverse
✓ test/accounting.test.ts > general ledger > header (non-postable) accounts cannot be posted to
✓ test/accounting.test.ts > general ledger > period close is blocked by drafts; posting into a closed period is rejected
✓ test/accounting.test.ts > general ledger > foreign currency: USD entry converted to LYD at 3 decimals using the dated rate
✓ test/accounting.test.ts > general ledger > Idempotency-Key replays the same response and rejects a different payload
✓ test/accounting.test.ts > general ledger > source documents post exactly once (integration contract)
✓ test/accounting.test.ts > general ledger > trial balance balances, ledger drills down, statements reconcile
✓ test/accounting.test.ts > general ledger > account with a balance cannot be deactivated
✓ test/accounting.test.ts > general ledger > every posting is in the audit trail, and the audit log is append-only
✓ test/tenant-isolation.test.ts > tenant isolation (RLS) > runtime DB role cannot bypass RLS
✓ test/tenant-isolation.test.ts > tenant isolation (RLS) > queries without tenant context see no tenant rows
✓ test/tenant-isolation.test.ts > tenant isolation (RLS) > a tenant context sees only its own rows even with no WHERE clause
✓ test/tenant-isolation.test.ts > tenant isolation (RLS) > cannot insert rows into another tenant
✓ test/tenant-isolation.test.ts > tenant isolation (RLS) > cannot reference another tenant's records (composite FK + RLS)
✓ test/tenant-isolation.test.ts > tenant isolation (RLS) > API: tenant A cannot read tenant B's company by id or list
✓ test/tenant-isolation.test.ts > tenant isolation (RLS) > API: tenant A cannot create a branch under tenant B's company
✓ test/tenant-isolation.test.ts > tenant isolation (RLS) > a token from tenant A forged with tenant B id is rejected (signature)
✓ test/tenant-isolation.test.ts > tenant isolation (RLS) > platform context cannot read tenant business data, only metadata/usage
✓ test/tenant-isolation.test.ts > tenant isolation (RLS) > tenant cannot call usage function for another tenant
✓ test/tenant-isolation.test.ts > tenant isolation (RLS) > tenant tokens cannot access platform endpoints and vice versa
Test Files  4 passed (4)
     Tests  52 passed (52)
  Duration  31.69s
```

Additional checks run in the same session:
* `tsc --noEmit` — server and web: 0 errors.
* `vite build` — web: success (235 kB JS, 72 kB gzip).
* Browser E2E journey — passed. The only browser console entry was the **expected** `403` when the owner tried to post their own entry (segregation of duties).
* Seed script run twice — second run created nothing (idempotent).

### Defects found by these tests and fixed during Phase 1
1. Three SQL parameter-type inference errors (lockout counter, reversal source id, period status) → 500 errors. Fixed with explicit casts.
2. **Design flaw:** the `*.view` wildcard granted the sensitive `core.audit.view` permission to the Read-Only role. Fixed: cross-module view wildcards never include sensitive permissions.
3. Test-data mistakes (one-character names rejected by validation; a wrong expected FX value) — tests corrected, product behaviour was right.


## Results — Phase 2b (2026-11-11)

`test/core-erp.test.ts` — 17 tests covering opening stock and weighted average, SoD on operational documents, goods receipt in alternative units with lots, supplier invoice/payment limits, duplicate supplier invoice numbers, credit sale in cartons with list price × factor and discount, FEFO, exact journal lines per account, credit limit, all-or-nothing rollback on insufficient stock, non-sellable warehouses, returns forced into quarantine and the original lot, over-return, quarantine release permission, damage write-off, FIFO receipts and customer advances, cash sale, **stock subledger = GL**, trial balance, lot trace to customers, AR aging, statement, margin analysis, item card, DB-level immutability, **expired lots never sold**, module gating.

Full suite: **69 / 69 passed** in 7 consecutive full runs after the fixes. One earlier run had 2 failures in the accounting suite that never reproduced (see KNOWN_ISSUES K12).

Browser E2E (demo-foods tenant): owner creates a user and drafts a credit invoice in cartons with a discount → sales manager posts it (journal JV created, lot shown, cost 40.640 = 48 × 0.8467 average) → AR aging → stock on hand ("reconciled with GL") → lot trace showing the customer. **This run uncovered the expired-lot defect**, fixed and covered by a test.


## Results — Phase 3 (2026-11-11)

`test/manufacturing.test.ts` — 9 tests: formula versioning, approval SoD, frozen approved lines, self-reference guard, standard cost roll-up (exact figure); order must output to quarantine, release freezes standard cost, expired material excluded from availability; issue via FEFO skipping the expired lot (verified by remaining lot quantities), non-formula item rejected, return at issue cost and over-return rejected, line hours absorbed; completion at actual cost (307.600), WIP cleared, operator cannot complete, cost report (yield 98%, potato std 164.64 vs actual 168, cost variance 30.652), completed order immutable; QC missing results, failed CCP → hold + NCR, release blocked, passing re-test does not lift the hold while NCR is open, close NCR + re-test → release; COGS of the released lot at LYD precision; genealogy backward to the supplier and forward to the customer; recall holds derived lots, blocks sale and production use, survives re-tests; MRP purchase suggestion; stock subledger = GL and trial balance balanced.

Full suite: **78 / 78** in 3 consecutive runs.

**Defect found by these tests:** the subledger/GL reconciliation failed by 0.0002 — stock values used 4 decimals while the GL uses the currency's 3. Fixed for all stock valuations.

Browser E2E (demo-foods): formula with standard cost → create, release, issue 4 materials, record hours, complete order → cost actual vs standard → QC entry with frying temperature 192 °C (CCP) → failed, lot on hold, NCR opened → trace from potato lot to the finished lot. No console errors.


## Results — Phase 4 (2026-11-11)

`test/field-sales.test.ts` — 14 tests: rep registration rules; expired stock cannot be loaded into a van; load requested by rep and posted by the warehouse; offline batch with 7 ops → 4 accepted / 3 rejected (unassigned customer, discount above ceiling, typed price); re-sync of the same batch → all replayed, still 2 invoices and the same van quantity; custody 50 = GL 1112; handover over custody rejected, rep cannot confirm own cash, counted > declared rejected, shortage 2.000 charged; settlement count required, approved by supervisor, shortage 2.400 charged; commission 2% of collected only, SoD on posting, sales manager cannot post, tiered calculation 5.500; performance vs targets (50% / 50% / 25%); isolation between reps; GPS policy and retry of a rejected op with the same clientId; recall queues one WhatsApp notice and blocks van sales of the lot; stock = GL and trial balance balanced.

Full suite: **92 / 92** in 6 of 8 runs; the 2 failing runs hit the open intermittent issue **K12** (see KNOWN_ISSUES), which has not reproduced since a diagnostic probe was added.

Browser E2E (phone viewport, demo-foods): rep goes offline, records an invoice and a visit (queued, "pending sync"), comes back online → automatic sync, queue empty; the same receipt sent twice → second response `replayed: true` with the same id; totals and custody correct after reload. **The first run of this test exposed that the van held only expired stock and the app displayed it as available — fixed (two rules + demo data).**
