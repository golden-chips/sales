# Release Notes — GOLDEN ERP 0.9.0 (trial feedback release, DEMO data only)

**What changed:** the changes asked for during the first trial — a faster, clearer POS (payment screen, several card/wallet accounts per cashier, new receipt, selling without internet), sign-in by username, a full Settings page with colour themes, roles editor and plan designer; year-end close, bank reconciliation and budgets; refunds, credit/debit notes, purchase price variance and landed costs; and security hardening (httpOnly refresh cookie + CSRF, encrypted MFA secrets, per-company request limit, fingerprint-device address allow-list, trusted-proxy fix).

**How it was checked:** 196 server tests, 23 browser tests in CI on a fresh database, the customer install script, and a POS rush load test (20 cashiers: 0 errors, p99 68 ms; flat out 48 sales/s, with invoices, stock and cash exact). See `TEST_REPORT_0.9_AR.md`, including what is not tested yet.

**Upgrading a trial server:** `deploy/update.sh` — migrations 017–022 run automatically and `setup.sh` adds `DATA_ENCRYPTION_KEY` and `TRUST_PROXY_HOPS` to `.env` (back the file up: the key protects stored MFA secrets).

**Still not for real company data:** see `GO_LIVE_AR.md` and `KNOWN_ISSUES.md`.

---

# Release Notes — GOLDEN ERP 0.8.0 (first full trial version, DEMO data only)

**What you can do today:** try every module end to end on the DEMO company — sales (quotations, orders with credit check and stock reservation, invoices, returns, receipts), purchasing (purchase orders with approval, receipts, supplier invoices, payments), inventory with lots and expiry, manufacturing and quality, field sales (rep app, settlements, commissions), point of sale, HR and payroll, fixed assets and maintenance, CRM, documents and approvals, projects, BI and smart insights, go-live tooling — in Arabic or English, signing in as any of 13 DEMO roles.

**How it was checked:** 167 server tests, DEMO data for every module with all subledgers reconciled to the GL, 21 browser tests (every screen for every role + 8 business flows) in CI. See `TEST_REPORT_0.8_AR.md`, including what is not tested yet.

**Not for real company data yet:** the trial is for finding gaps and agreeing changes before go-live (see `GO_LIVE_AR.md`, `KNOWN_ISSUES.md`).

---

# Release Notes — GOLDEN ERP 0.1.0 (internal, not production)

**What you can do today:** run the platform, provision companies on plans, manage users/roles/branches/warehouses, set up a chart of accounts and fiscal year, record, post and reverse journal entries with full controls, and read trial balance / ledger / summary statements — in Arabic or English.

**What is not there yet:** sales, purchasing, inventory, manufacturing, quality, distribution, HR/payroll and the other operational modules (see IMPLEMENTATION_PLAN.md). Not approved for production use — see KNOWN_ISSUES.md for pre-production gates.
