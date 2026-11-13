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
| K12 | ~~Medium~~ **Resolved (0.5.1)** | Intermittent test failures (accounting immutability test; GL/stock reads in core-erp and field-sales; reproduced on every GitHub CI run). **Root cause:** the `idempotent()` helper called `reply.send()` *inside* the DB transaction, so Fastify sent the response before COMMIT and the client's next request could read pre-commit state (e.g. a just-posted entry still `draft`). Affected 9 routes (journal create/post/reverse, stock-document/receipt/invoice create/post, production order create/issue/time/complete). Not a data-integrity bug (the transaction itself was correct), but a real read-your-writes race for API clients. **Fix:** `idempotent()` now returns the result and routes send it only after the transaction resolves (`send(reply, await tdb(...))`). Proven by injecting a 50 ms delay before COMMIT: old code fails the K12 test, new code passes all tests | Done — a read-your-writes assertion was added to the test |
| K13 | Medium | Sales orders & stock reservation, quotations, purchase requisitions/POs/RFQ/approvals not implemented | Phase 2b remainder |
| K14 | Medium | Supplier invoice must not exceed received value — purchase price variance and landed costs not supported | Phase 2b remainder |
| K15 | Medium | Return on a fully paid credit invoice is rejected (cash refund flow missing); debit/credit notes missing | Phase 2b remainder |
| K16 | Low | Serial numbers, bin locations, multiple price lists not implemented | Later |
| K17 | Low | Some UI inputs (supplier invoice number, unit codes, recall reason, work center) use browser `prompt()` | Replace with modals |
| K18 | Medium | Capacity planning, line scheduling, shifts, downtime/OEE, by-products not implemented | Phase 3 remainder |
| K19 | Medium | Weighted average is per warehouse+item, so all lots of an item share one cost (lot-level actual cost not supported) | Option for lot costing later if required |
| K20 | Medium | Recall notices are queued in the outbox but **not sent**: the WhatsApp sender (company's Meta account) is not connected yet | Connect sender worker |
| K21 | Medium | Existing Expo rep app not yet switched to the new API (adapter plan in FIELD_SALES_DISTRIBUTION.md); the web rep app is the tested alternative | Phase 4 remainder |
| K22 | Low | On phone width the top bar stacks its controls and takes too much height | UI polish |
| K23 | Low | Settlement overage on a lot-tracked item is put on the most recently moved lot in the van | Let the supervisor pick the lot |

Legacy systems findings (V1–V10, H1–H6) are in `PHASE0_DISCOVERY_AUDIT.md`; they live in the `van-sales-app` repository and were **not modified** in this phase.
| K24 | Medium | Self-service signup has no email/phone verification and no CAPTCHA (rate limited only) | Before public launch |
| K25 | Medium | Statutory payroll rates (social security, income tax) are not configured: each company defines them as pay components after its accountant confirms them | Decision D8 |
| K26 | Medium | Fingerprint devices cannot authenticate; a registered serial number is the only key (spoofable on the network). Restrict the iclock path to the factory IP at the proxy | Deployment |
| K27 | Low | Payroll: if earnings are smaller than statutory deductions, deduction line items are not pro-rated (total is capped) | Refine |
| K28 | Low | Web dependency advisories left: react-router moderate (fix = v7, breaking), vite dev-server high (dev only; fix = vite 6+) | Planned upgrade |
| K29 | Info | The APK talks to the server set in `GOLDEN_API_BASE`; without hosting (D5) it cannot reach a server | Hosting decision |
| K30 | Low | HR engine ports the core حضوري rules; rosters/rotating shifts, multiple sites, coverage pay and supervisor tools from حضوري are not ported yet | Phase 5 remainder |
| K31 | Medium | Assets: buying an asset on a supplier invoice (asset line in the supplier invoice) is not implemented — capitalization credits bank/cash/opening balance or a non-control liability | Phase 6 remainder |
| K32 | Low | Assets: revaluation, impairment, units-of-production depreciation, split/merge, inter-company transfer not implemented | Later |
| K33 | Medium | POS needs a live connection to complete a sale (retries are duplicate-safe via clientId, but there is no offline sales queue like the rep app) | Phase 6 remainder |
| K34 | Low | POS: no direct card-terminal or cash-drawer integration; card amounts are keyed in; printing uses the OS printer (80 mm layout) | Hardware integration |
| K35 | Low | POS promotions (buy-X-get-Y), loyalty points and gift cards not implemented | Later |
| K36 | Medium | BI alerts/schedules are queued to the outbox but not delivered (no e-mail/WhatsApp provider configured); periodic evaluation needs a server cron at deployment — today it is triggered from the UI/API | Hosting (D5) |
| K37 | Low | No free-form report builder or user-defined dashboards | Later |
| K38 | Info | Dashboards are computed live; very large data volumes may later need aggregate tables | Monitor after go-live |
| K39 | Medium | E-approvals are an audit trail (user, time, file SHA-256); a legally qualified digital signature (certificate authority) is not integrated | When a provider is chosen |
| K40 | Low | Documents are stored inside PostgreSQL (fine for trial/medium volume); large volumes should move to object storage | Before heavy use |
| K41 | Low | Projects: no Gantt chart, task dependencies or time sheets | Later |
| K42 | Info | Arabic AI assistant (natural-language questions on company data) not built: needs a decision on LLM provider, data residency/privacy and cost | Decision needed |
