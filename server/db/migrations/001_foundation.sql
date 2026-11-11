-- =====================================================================
-- GOLDEN ERP — Migration 001: SaaS foundation
-- Tenancy model: shared database, shared schema, tenant_id on every
-- tenant-owned row, enforced by PostgreSQL Row-Level Security (FORCE).
-- The application connects as role golden_app (NOSUPERUSER, NOBYPASSRLS),
-- so a missing WHERE clause in application code can never leak rows
-- across tenants.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'golden_app') THEN
    CREATE ROLE golden_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- Request context helpers (set with set_config(..., true) = transaction-local)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_is_platform() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.is_platform', true), '') = 'on'
$$;

CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- =====================================================================
-- GLOBAL CATALOGS (not tenant-owned, read-only for the app)
-- =====================================================================
CREATE TABLE currencies (
  code        char(3) PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
  name_ar     text NOT NULL,
  name_en     text NOT NULL,
  minor_units smallint NOT NULL CHECK (minor_units BETWEEN 0 AND 4)
);

CREATE TABLE modules (
  code       text PRIMARY KEY CHECK (code ~ '^[a-z_]+$'),
  name_ar    text NOT NULL,
  name_en    text NOT NULL,
  sort_order int NOT NULL DEFAULT 0
);

CREATE TABLE permissions (
  code        text PRIMARY KEY CHECK (code ~ '^[a-z_]+(\.[a-z_]+)+$'),
  module_code text NOT NULL REFERENCES modules(code),
  name_ar     text NOT NULL,
  name_en     text NOT NULL,
  is_sensitive boolean NOT NULL DEFAULT false
);

-- =====================================================================
-- PLATFORM (owner of the SaaS) — plans, tenants, subscriptions, billing
-- =====================================================================
CREATE TABLE platform_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  full_name     text NOT NULL,
  password_hash text NOT NULL,
  mfa_secret    text,
  mfa_enabled   boolean NOT NULL DEFAULT false,
  is_active     boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_platform_users_upd BEFORE UPDATE ON platform_users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_]+$'),
  name_ar         text NOT NULL,
  name_en         text NOT NULL,
  currency        char(3) NOT NULL REFERENCES currencies(code),
  price_monthly   numeric(14,3) NOT NULL CHECK (price_monthly >= 0),
  price_yearly    numeric(14,3) NOT NULL CHECK (price_yearly >= 0),
  trial_days      int NOT NULL DEFAULT 14 CHECK (trial_days BETWEEN 0 AND 365),
  grace_days      int NOT NULL DEFAULT 7  CHECK (grace_days BETWEEN 0 AND 90),
  max_users       int NOT NULL CHECK (max_users > 0),
  max_companies   int NOT NULL DEFAULT 1 CHECK (max_companies > 0),
  max_branches    int NOT NULL CHECK (max_branches > 0),
  max_warehouses  int NOT NULL CHECK (max_warehouses > 0),
  storage_mb      int NOT NULL CHECK (storage_mb > 0),
  api_rpm         int NOT NULL CHECK (api_rpm > 0),
  is_public       boolean NOT NULL DEFAULT true,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_plans_upd BEFORE UPDATE ON plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE plan_modules (
  plan_id     uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  module_code text NOT NULL REFERENCES modules(code),
  PRIMARY KEY (plan_id, module_code)
);

CREATE TYPE tenant_status AS ENUM ('trial', 'active', 'past_due', 'suspended', 'cancelled');

CREATE TABLE tenants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
  legal_name      text NOT NULL,
  name_en         text,
  industry        text,
  status          tenant_status NOT NULL DEFAULT 'trial',
  status_reason   text,
  base_currency   char(3) NOT NULL REFERENCES currencies(code),
  timezone        text NOT NULL DEFAULT 'UTC',
  default_locale  text NOT NULL DEFAULT 'ar' CHECK (default_locale IN ('ar','en')),
  secondary_locale text CHECK (secondary_locale IN ('ar','en')),
  is_demo         boolean NOT NULL DEFAULT false,
  brand_color     text CHECK (brand_color ~ '^#[0-9A-Fa-f]{6}$'),
  logo_url        text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_tenants_upd BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TYPE billing_cycle AS ENUM ('monthly', 'yearly');
CREATE TYPE subscription_status AS ENUM ('trialing', 'active', 'past_due', 'suspended', 'cancelled', 'superseded');

CREATE TABLE subscriptions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  plan_id              uuid NOT NULL REFERENCES plans(id),
  billing_cycle        billing_cycle NOT NULL DEFAULT 'monthly',
  status               subscription_status NOT NULL,
  price                numeric(14,3) NOT NULL CHECK (price >= 0),
  currency             char(3) NOT NULL REFERENCES currencies(code),
  trial_ends_at        timestamptz,
  current_period_start timestamptz NOT NULL,
  current_period_end   timestamptz NOT NULL,
  auto_renew           boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (current_period_end > current_period_start)
);
-- exactly one live subscription per tenant
CREATE UNIQUE INDEX uq_subscriptions_live ON subscriptions(tenant_id)
  WHERE status IN ('trialing', 'active', 'past_due', 'suspended');
CREATE TRIGGER trg_subscriptions_upd BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE subscription_events (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  subscription_id uuid REFERENCES subscriptions(id),
  event_type      text NOT NULL,
  from_plan_id    uuid REFERENCES plans(id),
  to_plan_id      uuid REFERENCES plans(id),
  note            text,
  actor_platform_user_id uuid REFERENCES platform_users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_subscription_events_tenant ON subscription_events(tenant_id, created_at DESC);

CREATE TYPE platform_invoice_status AS ENUM ('draft', 'issued', 'paid', 'void', 'overdue');
CREATE TABLE platform_invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number          text NOT NULL UNIQUE,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  subscription_id uuid NOT NULL REFERENCES subscriptions(id),
  period_start    timestamptz NOT NULL,
  period_end      timestamptz NOT NULL,
  amount          numeric(14,3) NOT NULL CHECK (amount >= 0),
  discount        numeric(14,3) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  currency        char(3) NOT NULL REFERENCES currencies(code),
  status          platform_invoice_status NOT NULL DEFAULT 'issued',
  issued_at       timestamptz NOT NULL DEFAULT now(),
  due_at          timestamptz NOT NULL,
  paid_at         timestamptz,
  CHECK (discount <= amount)
);
CREATE INDEX ix_platform_invoices_tenant ON platform_invoices(tenant_id, issued_at DESC);

-- Platform-level tables are protected too: a tenant session sees only its
-- own tenant row / subscription; only platform sessions see everything.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY p_tenants ON tenants
  USING (app_is_platform() OR id = app_tenant_id())
  WITH CHECK (app_is_platform());

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY p_subscriptions ON subscriptions
  USING (app_is_platform() OR tenant_id = app_tenant_id())
  WITH CHECK (app_is_platform());

ALTER TABLE subscription_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_events FORCE ROW LEVEL SECURITY;
CREATE POLICY p_subscription_events ON subscription_events
  USING (app_is_platform() OR tenant_id = app_tenant_id())
  WITH CHECK (app_is_platform());

ALTER TABLE platform_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY p_platform_invoices ON platform_invoices
  USING (app_is_platform() OR tenant_id = app_tenant_id())
  WITH CHECK (app_is_platform());

ALTER TABLE platform_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_users FORCE ROW LEVEL SECURITY;
CREATE POLICY p_platform_users ON platform_users
  USING (app_is_platform()) WITH CHECK (app_is_platform());

-- Login needs to resolve a tenant code before any tenant context exists.
-- This SECURITY DEFINER function exposes only id + status, nothing else.
CREATE OR REPLACE FUNCTION resolve_tenant(p_code text)
RETURNS TABLE (id uuid, status tenant_status, base_currency char(3), timezone text, default_locale text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, t.status, t.base_currency, t.timezone, t.default_locale FROM tenants t WHERE t.code = lower(p_code)
$$;

-- Platform login needs the hash before a platform context exists.
CREATE OR REPLACE FUNCTION platform_user_for_login(p_email text)
RETURNS TABLE (id uuid, full_name text, password_hash text, mfa_enabled boolean, mfa_secret text, is_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.full_name, u.password_hash, u.mfa_enabled, u.mfa_secret, u.is_active
  FROM platform_users u WHERE u.email = p_email::citext
$$;

-- =====================================================================
-- TENANT-OWNED TABLES
-- Every table carries tenant_id, has UNIQUE (tenant_id, id) so children
-- can use composite foreign keys (making cross-tenant references
-- impossible at the schema level), and gets the standard RLS policy.
-- =====================================================================
CREATE TABLE tenant_settings (
  tenant_id               uuid PRIMARY KEY REFERENCES tenants(id),
  date_format             text NOT NULL DEFAULT 'DD/MM/YYYY',
  number_locale           text NOT NULL DEFAULT 'ar-LY',
  fiscal_year_start_month smallint NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  enforce_sod             boolean NOT NULL DEFAULT true,
  mfa_required            boolean NOT NULL DEFAULT false,
  password_min_length     smallint NOT NULL DEFAULT 10 CHECK (password_min_length BETWEEN 8 AND 128),
  session_ttl_minutes     int NOT NULL DEFAULT 30 CHECK (session_ttl_minutes BETWEEN 5 AND 1440),
  max_failed_logins       smallint NOT NULL DEFAULT 5 CHECK (max_failed_logins BETWEEN 3 AND 20),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_tenant_settings_upd BEFORE UPDATE ON tenant_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE companies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  code          text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{1,20}$'),
  name_ar       text NOT NULL,
  name_en       text,
  base_currency char(3) NOT NULL REFERENCES currencies(code),
  tax_number    text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);
CREATE TRIGGER trg_companies_upd BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TYPE branch_kind AS ENUM ('head_office', 'factory', 'branch', 'warehouse_site', 'sales_office');
CREATE TABLE branches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  company_id  uuid NOT NULL,
  code        text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{1,20}$'),
  name_ar     text NOT NULL,
  name_en     text,
  kind        branch_kind NOT NULL DEFAULT 'branch',
  city        text,
  address     text,
  phone       text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id)
);
CREATE TRIGGER trg_branches_upd BEFORE UPDATE ON branches FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TYPE warehouse_kind AS ENUM ('main', 'raw_materials', 'packaging', 'finished_goods', 'wip', 'quarantine', 'damaged', 'van', 'transit');
CREATE TABLE warehouses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  branch_id   uuid NOT NULL,
  code        text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{1,20}$'),
  name_ar     text NOT NULL,
  name_en     text,
  kind        warehouse_kind NOT NULL DEFAULT 'main',
  is_sellable boolean NOT NULL DEFAULT true,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  -- quarantine / damaged stock must never be sellable (returns policy, §10.16)
  CHECK (NOT (kind IN ('quarantine', 'damaged') AND is_sellable))
);
CREATE TRIGGER trg_warehouses_upd BEFORE UPDATE ON warehouses FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- Identity & access
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  email             citext NOT NULL,
  full_name         text NOT NULL,
  phone             text,
  password_hash     text NOT NULL,
  locale            text NOT NULL DEFAULT 'ar' CHECK (locale IN ('ar','en')),
  is_active         boolean NOT NULL DEFAULT true,
  is_owner          boolean NOT NULL DEFAULT false,
  mfa_secret        text,
  mfa_enabled       boolean NOT NULL DEFAULT false,
  failed_logins     smallint NOT NULL DEFAULT 0,
  locked_until      timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  last_login_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, email)
);
CREATE TRIGGER trg_users_upd BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  code        text NOT NULL CHECK (code ~ '^[a-z0-9_]+$'),
  name_ar     text NOT NULL,
  name_en     text NOT NULL,
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE role_permissions (
  tenant_id       uuid NOT NULL,
  role_id         uuid NOT NULL,
  permission_code text NOT NULL REFERENCES permissions(code),
  PRIMARY KEY (role_id, permission_code),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles(tenant_id, id) ON DELETE CASCADE
);

-- branch_id NULL = role applies to all branches; otherwise scoped
CREATE TABLE user_roles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  user_id    uuid NOT NULL,
  role_id    uuid NOT NULL,
  branch_id  uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id)
);
CREATE UNIQUE INDEX uq_user_roles ON user_roles(user_id, role_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  family_id   uuid NOT NULL,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by uuid,
  ip          inet,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX ix_refresh_tokens_user ON refresh_tokens(user_id);

CREATE TABLE login_attempts (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid,          -- NULL for platform logins / unknown tenant
  scope       text NOT NULL CHECK (scope IN ('tenant','platform')),
  identifier  text NOT NULL,
  success     boolean NOT NULL,
  reason      text,
  ip          inet,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_login_attempts_lookup ON login_attempts(identifier, created_at DESC);

-- ---------------------------------------------------------------------
-- Audit log — append-only. UPDATE/DELETE are blocked by trigger AND by
-- privileges. tenant_id NULL = platform-level event.
-- ---------------------------------------------------------------------
CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid REFERENCES tenants(id),
  actor_type    text NOT NULL CHECK (actor_type IN ('user','platform','system')),
  actor_id      uuid,
  action        text NOT NULL,
  entity_type   text NOT NULL,
  entity_id     text,
  before_data   jsonb,
  after_data    jsonb,
  ip            inet,
  request_id    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_tenant_time ON audit_log(tenant_id, created_at DESC);
CREATE INDEX ix_audit_entity ON audit_log(tenant_id, entity_type, entity_id);

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER trg_audit_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------
-- API idempotency (Idempotency-Key header)
-- ---------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  key           text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  route         text NOT NULL,
  request_hash  text NOT NULL,
  status_code   int NOT NULL,
  response_body jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

-- ---------------------------------------------------------------------
-- Document numbering (gap-free per company/doc type, row-locked)
-- ---------------------------------------------------------------------
CREATE TABLE document_sequences (
  tenant_id   uuid NOT NULL,
  company_id  uuid NOT NULL,
  doc_type    text NOT NULL,
  prefix      text NOT NULL,
  next_value  bigint NOT NULL DEFAULT 1 CHECK (next_value > 0),
  padding     smallint NOT NULL DEFAULT 6,
  PRIMARY KEY (company_id, doc_type),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id)
);

-- =====================================================================
-- Standard RLS on every tenant-owned table
-- =====================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_settings','companies','branches','warehouses','users','roles',
                           'role_permissions','user_roles','refresh_tokens','idempotency_keys','document_sequences']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY p_tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

-- audit_log: tenants read their own, platform reads platform-level events only
-- (platform staff do NOT see tenant business audit trails by default).
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY p_audit_select ON audit_log FOR SELECT
  USING (tenant_id = app_tenant_id() OR (app_is_platform() AND tenant_id IS NULL));
CREATE POLICY p_audit_insert ON audit_log FOR INSERT
  WITH CHECK (tenant_id = app_tenant_id() OR (app_is_platform() AND (tenant_id IS NULL OR tenant_id = app_tenant_id())));

-- login_attempts: written by the app in either scope, readable per scope
ALTER TABLE login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY p_login_attempts_insert ON login_attempts FOR INSERT WITH CHECK (true);
CREATE POLICY p_login_attempts_select ON login_attempts FOR SELECT
  USING (tenant_id = app_tenant_id() OR (app_is_platform() AND scope = 'platform'));

-- Usage metering for the platform owner: counts only, never row data.
CREATE OR REPLACE FUNCTION platform_tenant_usage(p_tenant uuid)
RETURNS TABLE (users bigint, active_users bigint, companies bigint, branches bigint, warehouses bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT app_is_platform() AND p_tenant IS DISTINCT FROM app_tenant_id() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT
    (SELECT count(*) FROM users u WHERE u.tenant_id = p_tenant),
    (SELECT count(*) FROM users u WHERE u.tenant_id = p_tenant AND u.is_active),
    (SELECT count(*) FROM companies c WHERE c.tenant_id = p_tenant),
    (SELECT count(*) FROM branches b WHERE b.tenant_id = p_tenant),
    (SELECT count(*) FROM warehouses w WHERE w.tenant_id = p_tenant);
END $$;
