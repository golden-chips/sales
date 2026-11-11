# Known Issues & Limitations (honest list)

| # | Severity | Issue | Plan |
|---|---|---|---|
| K1 | High (pre-prod) | Refresh token kept in `sessionStorage` in the web app | httpOnly cookie + CSRF token before production |
| K2 | Medium | Rate limiting is in-memory per instance; per-tenant `api_rpm` not enforced | Redis store + tenant key generator |
| K3 | Medium | MFA secrets not encrypted at rest (RLS-protected) | App-level encryption with KMS key |
| K4 | Medium | Financial statements summary computed in JS numbers after SQL aggregation (rounded to 4 dp) | Move final arithmetic into SQL `numeric` |
| K5 | Medium | Year-end close, bank reconciliation, budgets, unrealized FX, fixed assets: not implemented | Phase 2 remainder |
| K6 | Medium | Reverse / reopen reasons use the browser `prompt()` dialog | Replace with in-app modal |
| K7 | Low | No performance/load test executed yet | k6 scenarios before go-live |
| K8 | Low | Backup/restore procedure documented but not drilled (no production env yet) | Go-live gate |
| K9 | Info | Plan prices are 0 placeholders | Owner decision D4 |
| K10 | Info | Modules 2b–6 not built; the UI shows only implemented screens and an honest roadmap | Per implementation plan |
| K11 | Info | Browser E2E is a manual Playwright script, not yet in CI | Add Playwright job |

Legacy systems findings (V1–V10, H1–H6) are in `PHASE0_DISCOVERY_AUDIT.md`; they live in the `van-sales-app` repository and were **not modified** in this phase.
