-- =====================================================================
-- GOLDEN ERP — Migration 007: Field sales & distribution (Phase 4)
-- Integrates the van-sales operating model:
--   * a rep is a user with a VAN warehouse (stock in custody) and a cash custody
--   * field invoices/receipts are posted immediately by the field app
--     (compensating control: end-of-day settlement approved by a supervisor)
--   * offline sync is idempotent per (rep, client operation id)
--   * cash handover is confirmed by a cashier (SoD); shortages are charged to the rep
--   * commissions accrue on COLLECTED money, approved by finance
-- =====================================================================

CREATE TABLE territories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  company_id uuid NOT NULL,
  code       text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{1,20}$'),
  name_ar    text NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, code),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id)
);
ALTER TABLE parties ADD COLUMN territory_id uuid, ADD COLUMN lat numeric(9,6), ADD COLUMN lng numeric(9,6),
  ADD CONSTRAINT fk_parties_territory FOREIGN KEY (tenant_id, territory_id) REFERENCES territories(tenant_id, id);

CREATE TYPE commission_type AS ENUM ('none', 'flat', 'tiered');

CREATE TABLE sales_reps (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  company_id         uuid NOT NULL,
  user_id            uuid NOT NULL,
  code               text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{1,20}$'),
  van_warehouse_id   uuid NOT NULL,
  territory_id       uuid,
  commission_type    commission_type NOT NULL DEFAULT 'none',
  commission_rate    numeric(7,4) NOT NULL DEFAULT 0 CHECK (commission_rate BETWEEN 0 AND 100),   -- flat %
  max_discount_pct   numeric(7,4) NOT NULL DEFAULT 0 CHECK (max_discount_pct BETWEEN 0 AND 100),  -- field discount ceiling
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, code),
  UNIQUE (user_id),
  UNIQUE (van_warehouse_id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, van_warehouse_id) REFERENCES warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, territory_id) REFERENCES territories(tenant_id, id)
);

-- tiered commission: rate applies to the slice of monthly collections up to `up_to` (NULL = no ceiling)
CREATE TABLE commission_tiers (
  tenant_id uuid NOT NULL,
  rep_id    uuid NOT NULL,
  tier_no   smallint NOT NULL,
  up_to     numeric(20,4) CHECK (up_to > 0),
  rate      numeric(7,4) NOT NULL CHECK (rate BETWEEN 0 AND 100),
  PRIMARY KEY (rep_id, tier_no),
  FOREIGN KEY (tenant_id, rep_id) REFERENCES sales_reps(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE rep_targets (
  tenant_id  uuid NOT NULL,
  rep_id     uuid NOT NULL,
  period     char(7) NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),
  sales_target      numeric(20,4) NOT NULL DEFAULT 0 CHECK (sales_target >= 0),
  collection_target numeric(20,4) NOT NULL DEFAULT 0 CHECK (collection_target >= 0),
  visits_target     int NOT NULL DEFAULT 0 CHECK (visits_target >= 0),
  PRIMARY KEY (rep_id, period),
  FOREIGN KEY (tenant_id, rep_id) REFERENCES sales_reps(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE routes (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  rep_id    uuid NOT NULL,
  weekday   smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),     -- 0 = Sunday
  name      text NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (rep_id, weekday),
  FOREIGN KEY (tenant_id, rep_id) REFERENCES sales_reps(tenant_id, id) ON DELETE CASCADE
);
CREATE TABLE route_stops (
  tenant_id   uuid NOT NULL,
  route_id    uuid NOT NULL,
  seq         smallint NOT NULL,
  customer_id uuid NOT NULL,
  PRIMARY KEY (route_id, customer_id),
  UNIQUE (route_id, seq),
  FOREIGN KEY (tenant_id, route_id) REFERENCES routes(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, customer_id) REFERENCES parties(tenant_id, id)
);

CREATE TYPE visit_outcome AS ENUM ('sale', 'collection', 'no_order', 'closed', 'refused', 'other');
CREATE TABLE visits (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  rep_id      uuid NOT NULL,
  customer_id uuid NOT NULL,
  visited_at  timestamptz NOT NULL,
  outcome     visit_outcome NOT NULL,
  lat         numeric(9,6),
  lng         numeric(9,6),
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, rep_id) REFERENCES sales_reps(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES parties(tenant_id, id),
  CHECK ((lat IS NULL) = (lng IS NULL))
);
CREATE INDEX ix_visits_rep_time ON visits(rep_id, visited_at DESC);

-- company policy: GPS on field visits (off by default; enabling it is a privacy decision of the tenant)
ALTER TABLE tenant_settings ADD COLUMN field_gps_required boolean NOT NULL DEFAULT false;

-- link field documents to the rep
ALTER TABLE sales_invoices ADD COLUMN rep_id uuid, ADD CONSTRAINT fk_si_rep FOREIGN KEY (tenant_id, rep_id) REFERENCES sales_reps(tenant_id, id);
ALTER TABLE payments ADD COLUMN rep_id uuid, ADD CONSTRAINT fk_pay_rep FOREIGN KEY (tenant_id, rep_id) REFERENCES sales_reps(tenant_id, id);
CREATE INDEX ix_si_rep ON sales_invoices(rep_id, invoice_date) WHERE rep_id IS NOT NULL;
CREATE INDEX ix_pay_rep ON payments(rep_id, payment_date) WHERE rep_id IS NOT NULL;

-- idempotent offline sync: one row per (rep, client operation id)
CREATE TABLE field_ops (
  tenant_id   uuid NOT NULL,
  rep_id      uuid NOT NULL,
  client_id   text NOT NULL CHECK (length(client_id) BETWEEN 8 AND 100),
  op_type     text NOT NULL,
  status      text NOT NULL CHECK (status IN ('ok', 'error')),
  result      jsonb NOT NULL,
  client_time timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rep_id, client_id),
  FOREIGN KEY (tenant_id, rep_id) REFERENCES sales_reps(tenant_id, id)
);

-- cash custody handover: rep declares, cashier confirms the counted amount
CREATE TYPE handover_status AS ENUM ('submitted', 'confirmed', 'rejected');
CREATE TABLE cash_handovers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  company_id       uuid NOT NULL,
  rep_id           uuid NOT NULL,
  number           text,
  handover_date    date NOT NULL,
  declared_amount  numeric(20,4) NOT NULL CHECK (declared_amount >= 0),
  counted_amount   numeric(20,4) CHECK (counted_amount >= 0),
  status           handover_status NOT NULL DEFAULT 'submitted',
  notes            text,
  journal_entry_id uuid,
  created_by       uuid NOT NULL,
  confirmed_by     uuid,
  confirmed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, number),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, rep_id) REFERENCES sales_reps(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, confirmed_by) REFERENCES users(tenant_id, id),
  CHECK (status <> 'confirmed' OR (counted_amount IS NOT NULL AND confirmed_by IS NOT NULL))
);

-- end-of-day van settlement: counted vs book quantities; approval posts differences
CREATE TYPE settlement_status AS ENUM ('submitted', 'approved', 'rejected');
CREATE TABLE van_settlements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  company_id       uuid NOT NULL,
  rep_id           uuid NOT NULL,
  number           text,
  settlement_date  date NOT NULL,
  status           settlement_status NOT NULL DEFAULT 'submitted',
  shortage_value   numeric(20,4),
  overage_value    numeric(20,4),
  notes            text,
  journal_entry_id uuid,
  created_by       uuid NOT NULL,
  approved_by      uuid,
  approved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, number),
  UNIQUE (rep_id, settlement_date),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, rep_id) REFERENCES sales_reps(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES users(tenant_id, id)
);
CREATE TABLE van_settlement_lines (
  tenant_id     uuid NOT NULL,
  settlement_id uuid NOT NULL,
  item_id       uuid NOT NULL,
  book_qty      numeric(20,4) NOT NULL,
  counted_qty   numeric(20,4) NOT NULL CHECK (counted_qty >= 0),
  PRIMARY KEY (settlement_id, item_id),
  FOREIGN KEY (tenant_id, settlement_id) REFERENCES van_settlements(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id)
);

CREATE TYPE commission_run_status AS ENUM ('draft', 'posted');
CREATE TABLE commission_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  company_id       uuid NOT NULL,
  period           char(7) NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),
  status           commission_run_status NOT NULL DEFAULT 'draft',
  total            numeric(20,4) NOT NULL DEFAULT 0,
  journal_entry_id uuid,
  created_by       uuid NOT NULL,
  posted_by        uuid,
  posted_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, posted_by) REFERENCES users(tenant_id, id)
);
-- one live (draft or posted) run per company+period
CREATE UNIQUE INDEX uq_commission_runs_period ON commission_runs(company_id, period);
CREATE TABLE commission_lines (
  tenant_id  uuid NOT NULL,
  run_id     uuid NOT NULL,
  rep_id     uuid NOT NULL,
  collected  numeric(20,4) NOT NULL,
  commission numeric(20,4) NOT NULL CHECK (commission >= 0),
  PRIMARY KEY (run_id, rep_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES commission_runs(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, rep_id) REFERENCES sales_reps(tenant_id, id)
);

-- outbound notifications (WhatsApp/SMS); a sender worker delivers them when a channel is configured
CREATE TYPE notification_status AS ENUM ('queued', 'sent', 'failed', 'cancelled');
CREATE TABLE notification_outbox (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  channel     text NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'email')),
  recipient   text NOT NULL,
  party_id    uuid,
  template    text NOT NULL,
  payload     jsonb NOT NULL,
  status      notification_status NOT NULL DEFAULT 'queued',
  source_type text,
  source_id   uuid,
  attempts    int NOT NULL DEFAULT 0,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz,
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id)
);
CREATE INDEX ix_outbox_status ON notification_outbox(status, created_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['territories','sales_reps','commission_tiers','rep_targets','routes','route_stops','visits','field_ops','cash_handovers',
                           'van_settlements','van_settlement_lines','commission_runs','commission_lines','notification_outbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY p_tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO golden_app', t);
  END LOOP;
END $$;
REVOKE UPDATE, DELETE ON field_ops, visits FROM golden_app;

INSERT INTO permissions (code, module_code, name_ar, name_en, is_sensitive) VALUES
  ('distribution.field.app',          'distribution', 'استخدام تطبيق المندوب (مسار اليوم، فواتير وتحصيل ميداني)', 'Use the field app (route, field invoices & collections)', false),
  ('distribution.field.load',         'distribution', 'طلب تحميل السيارة وتسليم العهدة وتسوية اليوم', 'Request van load, hand over cash, submit day settlement', false),
  ('distribution.reps.view',          'distribution', 'عرض المناديب وأدائهم', 'View reps & performance', false),
  ('distribution.reps.manage',        'distribution', 'إدارة المناديب والمسارات والأهداف والمناطق', 'Manage reps, routes, targets, territories', true),
  ('distribution.settlements.approve','distribution', 'اعتماد تسوية اليوم (جرد السيارة)', 'Approve day settlements', true),
  ('distribution.cash.confirm',       'distribution', 'استلام عهدة المندوب النقدية', 'Confirm rep cash handovers', true),
  ('distribution.commissions.run',    'distribution', 'احتساب وترحيل العمولات', 'Calculate & post commissions', true),
  ('distribution.notifications.view', 'distribution', 'عرض رسائل العملاء الصادرة', 'View outbound customer notifications', false);
