# Installation, Configuration, Deployment & Recovery

## 1. Requirements
* Node.js 22+, npm 10+
* PostgreSQL 16 with contrib extensions (`pgcrypto`, `citext`, `btree_gist`)

## 2. Local setup

```bash
# 1. Database (as a PostgreSQL superuser)
sudo -u postgres psql -c "CREATE ROLE golden_owner LOGIN SUPERUSER PASSWORD '<owner-pw>';"
sudo -u postgres psql -c "CREATE DATABASE golden_dev OWNER golden_owner;"
sudo -u postgres psql -c "CREATE DATABASE golden_test OWNER golden_owner;"

# 2. API
cd server
npm ci
cp .env.example .env            # fill in values (see §3)
set -a; . ./.env; set +a
npm run db:migrate              # applies db/migrations as the OWNER role; creates role golden_app
# set the runtime role password (first time only):
psql "$DATABASE_ADMIN_URL" -c "ALTER ROLE golden_app LOGIN PASSWORD '$APP_DB_PASSWORD'; GRANT CONNECT ON DATABASE golden_dev TO golden_app;"
npm run db:seed                 # platform admin, plans, golden-chips tenant, demo tenant (idempotent)
npm run dev                     # http://localhost:4000 · API docs: http://localhost:4000/api/docs

# 3. Web
cd ../web && npm ci && npm run dev   # http://localhost:5173 (proxies /api to :4000)

# 4. Tests (rebuild golden_test from scratch on every run)
cd ../server && npm test
```

Dev-only shortcut: `npx tsx scripts/reset-db.ts` drops and rebuilds a database **only** if its name ends in `_dev` or `_test`.

## 3. Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✔ | Runtime connection **as `golden_app`** (RLS enforced). Never the owner/superuser. |
| `DATABASE_ADMIN_URL` | migrations/seed | Owner connection for migrations and seeding only |
| `APP_DB_PASSWORD` | reset/seed | Password to set for `golden_app` |
| `JWT_SECRET` | ✔ | ≥ 32 random chars (`openssl rand -base64 48`) |
| `PLATFORM_JWT_SECRET` | ✔ | ≥ 32 random chars, **different** from `JWT_SECRET` |
| `DATA_ENCRYPTION_KEY` | production | ≥ 32 random chars; encrypts MFA secrets in the database (AES-256-GCM). **Back it up with the database** — without it, users with two-step verification cannot sign in. If unset, a key is derived from `JWT_SECRET` (then changing `JWT_SECRET` breaks MFA). `setup.sh` generates it |
| `TRUST_PROXY_HOPS` | | reverse proxies whose `X-Forwarded-For` is trusted: 1 = nginx (default), 2 = Caddy + nginx, 0 = none. A wrong value lets clients fake their address (login limits, device allow-list) |
| `SECURE_COOKIES` | | `auto` (default: Secure flag when the request came over HTTPS), `on`, `off` |
| `TENANT_RATE_LIMIT` | | `on` (default) enforces each plan's requests-per-minute for the whole company; `off` for load tests |
| `ICLOCK_ALLOWED_IPS` | | optional, e.g. `41.208.10.5,10.0.0.0/24`: fingerprint devices may push only from these addresses (each device can also have its own list in Settings) |
| `ACCESS_TOKEN_TTL_SEC` | | default 900 |
| `REFRESH_TOKEN_TTL_SEC` | | default 604800 (7 days) |
| `PORT`, `HOST` | | default 4000, 0.0.0.0 |
| `CORS_ORIGINS` | | comma-separated allow-list |
| `RATE_LIMIT_PER_MIN`, `LOGIN_RATE_LIMIT_PER_MIN` | | default 300 / 10 per IP (requests without a session) |
| `USER_RATE_LIMIT_PER_MIN` | | default 600 per signed-in session |
| `LOG_LEVEL` | | pino level, default `info` |
| `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD` | seed | first platform super admin |
| `GOLDEN_OWNER_EMAIL`, `GOLDEN_OWNER_PASSWORD` | seed | owner of tenant `golden-chips` |

## 4. Production deployment (recommended baseline)
1. Managed PostgreSQL 16 (or a dedicated VM) with **PITR (WAL archiving)**, encrypted storage, private network only.
2. API behind a TLS-terminating reverse proxy (Caddy/Nginx); `NODE_ENV=production` (the server refuses to start if `DATABASE_URL` bypasses RLS). Rate limits and each company's request budget are counted per API process: with several instances, each allows the full budget (a shared store such as Redis is needed to count across instances — not built yet).
3. Web: `npm run build` → static `web/dist` served by the same proxy; `/api` proxied to the API.
4. Secrets in the host's secret manager, never in files committed to git.
5. Separate **dev / staging / production** databases and secrets.

## 5. Backup & recovery
| Item | Policy (target) |
|---|---|
| Continuous | WAL archiving → PITR window 14 days |
| Daily | `pg_dump -Fc` encrypted (age/GPG) to off-site object storage, 35-day retention |
| Monthly | archived 12 months |
| Restore drill | **monthly** restore into staging + run the test suite & a trial-balance check against it |

Restore (logical dump):
```bash
pg_restore -d "postgres://golden_owner:...@host/golden_restore" --no-owner --role=golden_owner backup.dump
psql ... -c "ALTER ROLE golden_app LOGIN PASSWORD '...'"
```
> Status: the procedure is documented; **a restore drill has not been executed yet** (no production environment exists). It is a go-live gate.

## 6. Disaster recovery targets
RPO ≤ 15 min (WAL), RTO ≤ 4 h. Runbook: provision DB from latest base backup + WAL → point API `DATABASE_URL` to it → verify `/health` → verify trial balance totals per tenant against last known values → reopen traffic.

## 7. Troubleshooting
| Symptom | Cause / fix |
|---|---|
| Server logs "role bypasses RLS" | `DATABASE_URL` uses the owner/superuser — switch to `golden_app` |
| `Migration X was modified after being applied` | Never edit an applied migration; add a new numbered file |
| `permission denied for table …` | Run migrations (grants are in `003_*`) or the new table lacks a GRANT |
| Login always `INVALID_CREDENTIALS` | Wrong tenant **code** (e.g. `golden-chips`), or account locked (`ACCOUNT_LOCKED`, wait or ask admin to unlock) |
| `402 MODULE_NOT_IN_PLAN` | The tenant's plan does not include that module |
| `422 UNBALANCED_ENTRY` / `PERIOD_CLOSED` / `SEGREGATION_OF_DUTIES` | Business rules — see `ACCOUNTING_WORKFLOWS.md` |
