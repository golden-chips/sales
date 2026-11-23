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
| Web session (0.9) | Refresh token in an `httpOnly; SameSite=Strict` cookie limited to `/api/v1/auth` (Secure over HTTPS), never visible to page scripts; browser-session lifetime (gone when the browser closes) plus the server-side expiry; the short-lived access token stays in tab storage. Two tabs refreshing at once are serialised (Web Locks) and a rotation race within 20 s is answered "retry" instead of revoking the session. The Android app (another origin) keeps the token in its private storage and sends it in the body |
| CSRF | All data endpoints need `Authorization: Bearer` (a header a forged cross-site request cannot set). The only cookie-authenticated endpoint, `/auth/refresh`, also requires `X-CSRF-Token` equal to the readable `ge_csrf` cookie (double submit) and the cookies are `SameSite=Strict` |
| Secrets at rest (0.9) | MFA (TOTP) secrets encrypted with AES-256-GCM (`DATA_ENCRYPTION_KEY`); secrets saved before 0.9 are re-encrypted at the next sign-in |
| Per-company limit (0.9) | Each plan's requests per minute (`api_rpm`) applies to all the company's users together (429 `TENANT_RATE_LIMITED` with `Retry-After`), on top of the per-session and per-IP limits |
| Client address | Only the configured number of reverse proxies is trusted for `X-Forwarded-For` (`TRUST_PROXY_HOPS`), so a client cannot fake its IP |
| Fingerprint devices (0.9) | Devices cannot authenticate (iclock/ADMS sends only a serial number). Each device can be limited to listed addresses / ranges, and `ICLOCK_ALLOWED_IPS` limits all devices; pushes from elsewhere are refused and logged |

## Known gaps (tracked in KNOWN_ISSUES.md)
* Rate limits and the per-company budget are counted per API process (in memory); a multi-instance deployment needs a shared store (Redis).
* The data encryption key is an environment variable, not a managed key service (KMS); key rotation is not automated.
* A fingerprint device on a network without a fixed public address can only be identified by its serial number.
* No penetration test or dependency audit pipeline yet (npm audit reported 0 vulnerabilities for the server at install time; web reported advisories in dev tooling — review before production).
* Webhooks, file uploads and e-signatures are not implemented yet, so their controls do not exist yet.

## Reporting
Security issues: contact the platform owner privately; do not open public issues.
