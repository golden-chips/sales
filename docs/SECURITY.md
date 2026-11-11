# Security

## Implemented controls (Phase 1) — each backed by tests unless noted

| Area | Control |
|---|---|
| Tenant isolation | PostgreSQL FORCE RLS on all tenant tables; non-superuser `golden_app` runtime role (server refuses to start in production otherwise); transaction-local context; composite tenant FKs; platform staff see metadata only |
| Authentication | bcrypt (12 rounds); generic error for unknown tenant/user/wrong password with equalized timing (dummy hash); lockout after N failures (tenant-configurable, default 5, 15 min); every attempt logged with IP/UA |
| Sessions | 15-min JWT (HS256, issuer-checked, separate secrets for tenant and platform tokens); opaque refresh tokens stored as SHA-256; **rotation on every use; reuse of a rotated token revokes the whole session family**; sessions revoked on password change, role change, deactivation, tenant suspension |
| MFA | TOTP (RFC 6238) for tenant and platform users; tenant can require MFA |
| Password policy | min length (tenant setting, default 10) + 3 of 4 character classes |
| Authorization | Server-side `can(permission, module)` on every route; permissions loaded fresh per request (revocation immediate); module-in-plan check (402); branch scoping; **privilege-escalation guard** (cannot grant/assign permissions you don't hold; only the owner assigns owner); sensitive permissions excluded from `*.view` wildcards |
| Segregation of duties | Creator cannot post own journal entry when `enforce_sod` (default on) |
| Data integrity | Ledger rules enforced by DB triggers/constraints (see DATABASE.md) |
| Audit | Append-only `audit_log` in the same transaction as the change; passwords/secrets/token hashes scrubbed |
| API hardening | Helmet headers, CORS allow-list, 1 MB body limit, global + login rate limits, request id on every response, no stack traces to clients, zod validation, parameterized SQL only, whitelisted ORDER BY |
| Secrets | Only from environment variables; `.env` git-ignored; startup asserts JWT secrets ≥ 32 chars and distinct |
| XSS | React escapes output; no `dangerouslySetInnerHTML` |
| CSRF | API uses `Authorization: Bearer` headers, not cookies → not CSRF-exposed in the current design |

## Known gaps (tracked in KNOWN_ISSUES.md)
* Web stores tokens in `sessionStorage` (tab-scoped). Before production: move the refresh token to an `httpOnly; Secure; SameSite=Strict` cookie and add CSRF protection for that endpoint.
* Rate limiting is per process (in-memory); multi-instance deployments need a Redis store, and per-tenant `api_rpm` enforcement is not wired yet.
* MFA secrets are stored in plain text in the DB (protected by RLS); encrypt with an application KMS key before production.
* No penetration test or dependency audit pipeline yet (npm audit reported 0 vulnerabilities for the server at install time; web reported advisories in dev tooling — review before production).
* Webhooks, file uploads and e-signatures are not implemented yet, so their controls do not exist yet.

## Reporting
Security issues: contact the platform owner privately; do not open public issues.
