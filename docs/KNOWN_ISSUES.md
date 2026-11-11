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
| K12 | Medium | **One unexplained intermittent test failure** (accounting suite: a journal post returned non-200 once in 9 full runs; never reproduced). An assertion now prints the API error if it recurs | Investigate on next occurrence |
| K13 | Medium | Sales orders & stock reservation, quotations, purchase requisitions/POs/RFQ/approvals not implemented | Phase 2b remainder |
| K14 | Medium | Supplier invoice must not exceed received value — purchase price variance and landed costs not supported | Phase 2b remainder |
| K15 | Medium | Return on a fully paid credit invoice is rejected (cash refund flow missing); debit/credit notes missing | Phase 2b remainder |
| K16 | Low | Serial numbers, bin locations, multiple price lists not implemented | Later |
| K17 | Low | Some UI inputs (supplier invoice number, unit codes, recall reason, work center) use browser `prompt()` | Replace with modals |
| K18 | Medium | Capacity planning, line scheduling, shifts, downtime/OEE, by-products not implemented | Phase 3 remainder |
| K19 | Medium | Weighted average is per warehouse+item, so all lots of an item share one cost (lot-level actual cost not supported) | Option for lot costing later if required |
| K20 | Low | Recall does not yet notify customers automatically (list is produced; WhatsApp integration in Phase 4) | Phase 4 |

Legacy systems findings (V1–V10, H1–H6) are in `PHASE0_DISCOVERY_AUDIT.md`; they live in the `van-sales-app` repository and were **not modified** in this phase.
