-- =====================================================================
-- GOLDEN ERP — Migration 010: Fixed assets & maintenance (Phase 6a)
-- Asset register with categories that point at explicit GL accounts
-- (cost, accumulated depreciation, depreciation expense, maintenance
-- expense), capitalization (incl. opening balances of assets already in
-- use), monthly depreciation runs (straight line / double declining with
-- switch to straight line), disposal with gain/loss, preventive plans and
-- corrective/preventive work orders that consume spare parts from stock.
-- All money posts through the GL integration contract (postFromSource).
-- =====================================================================

CREATE TYPE dep_method AS ENUM ('straight_line', 'declining_balance');
CREATE TYPE asset_kind AS ENUM ('machine', 'equipment', 'vehicle', 'building', 'furniture', 'it', 'other');
CREATE TYPE asset_status AS ENUM ('draft', 'active', 'disposed');

CREATE TABLE asset_categories (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL,
  company_id              uuid NOT NULL,
  code                    text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{1,20}$'),
  name_ar                 text NOT NULL,
  name_en                 text,
  method                  dep_method NOT NULL DEFAULT 'straight_line',
  useful_life_months      integer NOT NULL CHECK (useful_life_months BETWEEN 1 AND 1200),
  residual_pct            numeric(5,2) NOT NULL DEFAULT 0 CHECK (residual_pct >= 0 AND residual_pct < 100),
  asset_account_id        uuid NOT NULL,
  accum_account_id        uuid NOT NULL,
  expense_account_id      uuid NOT NULL,
  maintenance_account_id  uuid,
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, code),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, asset_account_id) REFERENCES accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, accum_account_id) REFERENCES accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, expense_account_id) REFERENCES accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, maintenance_account_id) REFERENCES accounts(tenant_id, id),
  CHECK (asset_account_id <> accum_account_id AND accum_account_id <> expense_account_id)
);

CREATE TABLE fixed_assets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  company_id            uuid NOT NULL,
  branch_id             uuid,
  category_id           uuid NOT NULL,
  code                  text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{1,30}$'),
  name_ar               text NOT NULL,
  name_en               text,
  kind                  asset_kind NOT NULL DEFAULT 'equipment',
  serial_no             text,
  manufacturer          text,
  model                 text,
  location              text,
  work_center_id        uuid,              -- production line the machine belongs to
  warehouse_id          uuid,              -- a vehicle used as a van warehouse
  acquisition_date      date NOT NULL,
  in_service_date       date NOT NULL,
  cost                  numeric(20,4) NOT NULL CHECK (cost > 0),
  residual_value        numeric(20,4) NOT NULL DEFAULT 0 CHECK (residual_value >= 0),
  useful_life_months    integer NOT NULL CHECK (useful_life_months BETWEEN 1 AND 1200),
  method                dep_method NOT NULL,
  -- assets already in use at go-live: depreciation accumulated before this system
  opening_accumulated   numeric(20,4) NOT NULL DEFAULT 0 CHECK (opening_accumulated >= 0),
  opening_months_used   integer NOT NULL DEFAULT 0 CHECK (opening_months_used >= 0),
  accumulated_depreciation numeric(20,4) NOT NULL DEFAULT 0 CHECK (accumulated_depreciation >= 0),
  months_depreciated    integer NOT NULL DEFAULT 0 CHECK (months_depreciated >= 0),
  status                asset_status NOT NULL DEFAULT 'draft',
  funding_account_id    uuid,              -- credit side of capitalization (AP, bank, opening equity…)
  journal_entry_id      uuid,
  disposal_date         date,
  disposal_proceeds     numeric(20,4),
  disposal_reason       text,
  disposal_journal_id   uuid,
  notes                 text,
  is_demo               boolean NOT NULL DEFAULT false,
  created_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  posted_by             uuid,
  posted_at             timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, code),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES asset_categories(tenant_id, id),
  FOREIGN KEY (tenant_id, work_center_id) REFERENCES work_centers(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, funding_account_id) REFERENCES accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries(tenant_id, id),
  FOREIGN KEY (tenant_id, disposal_journal_id) REFERENCES journal_entries(tenant_id, id),
  CHECK (residual_value < cost),
  CHECK (in_service_date >= acquisition_date),
  CHECK (opening_accumulated + residual_value <= cost),
  CHECK (opening_months_used <= useful_life_months),
  CHECK (accumulated_depreciation + residual_value <= cost),
  CHECK (status <> 'disposed' OR (disposal_date IS NOT NULL AND disposal_journal_id IS NOT NULL))
);
CREATE INDEX ix_fixed_assets_company ON fixed_assets (company_id, status);

-- once capitalized, the financial definition of an asset is frozen; only the
-- depreciation counters, location data and the disposal fields may change
CREATE OR REPLACE FUNCTION trg_fixed_asset_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'a capitalized asset cannot be deleted; dispose of it instead'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'disposed' THEN
    IF (to_jsonb(NEW) - 'location' - 'notes') <> (to_jsonb(OLD) - 'location' - 'notes') THEN RAISE EXCEPTION 'disposed asset is immutable'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'draft' AND (NEW.cost, NEW.residual_value, NEW.useful_life_months, NEW.method, NEW.category_id, NEW.acquisition_date, NEW.in_service_date,
       NEW.opening_accumulated, NEW.opening_months_used, NEW.company_id, NEW.funding_account_id, NEW.journal_entry_id)
     IS DISTINCT FROM (OLD.cost, OLD.residual_value, OLD.useful_life_months, OLD.method, OLD.category_id, OLD.acquisition_date, OLD.in_service_date,
       OLD.opening_accumulated, OLD.opening_months_used, OLD.company_id, OLD.funding_account_id, OLD.journal_entry_id) THEN
    RAISE EXCEPTION 'financial fields of a capitalized asset are frozen';
  END IF;
  IF NEW.status = 'draft' AND OLD.status <> 'draft' THEN RAISE EXCEPTION 'an asset cannot return to draft'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fixed_asset_guard BEFORE UPDATE OR DELETE ON fixed_assets FOR EACH ROW EXECUTE FUNCTION trg_fixed_asset_guard();

CREATE TABLE depreciation_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  company_id       uuid NOT NULL,
  period           date NOT NULL CHECK (extract(day FROM period) = 1),   -- first day of the month
  status           doc_status NOT NULL DEFAULT 'draft',
  number           text,
  total            numeric(20,4) NOT NULL DEFAULT 0,
  journal_entry_id uuid,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  posted_by        uuid,
  posted_at        timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, period),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries(tenant_id, id)
);

CREATE TABLE depreciation_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  run_id            uuid NOT NULL,
  asset_id          uuid NOT NULL,
  period            date NOT NULL,
  amount            numeric(20,4) NOT NULL CHECK (amount > 0),
  accumulated_before numeric(20,4) NOT NULL,
  accumulated_after numeric(20,4) NOT NULL,
  book_value_after  numeric(20,4) NOT NULL,
  UNIQUE (asset_id, period),                 -- an asset is never depreciated twice for a month
  FOREIGN KEY (tenant_id, run_id) REFERENCES depreciation_runs(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fixed_assets(tenant_id, id),
  CHECK (accumulated_after = accumulated_before + amount)
);

CREATE OR REPLACE FUNCTION trg_dep_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'a posted depreciation run cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'a posted depreciation run is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dep_run_guard BEFORE UPDATE OR DELETE ON depreciation_runs FOR EACH ROW EXECUTE FUNCTION trg_dep_run_guard();

CREATE OR REPLACE FUNCTION trg_dep_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st doc_status;
BEGIN
  SELECT status INTO st FROM depreciation_runs WHERE id = COALESCE(NEW.run_id, OLD.run_id);
  IF st IS NOT NULL AND st <> 'draft' THEN RAISE EXCEPTION 'lines of a posted depreciation run are immutable'; END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER dep_line_guard BEFORE INSERT OR UPDATE OR DELETE ON depreciation_lines FOR EACH ROW EXECUTE FUNCTION trg_dep_line_guard();

-- ------------------------------------------------------------------ maintenance
CREATE TABLE maintenance_plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  company_id      uuid NOT NULL,
  asset_id        uuid NOT NULL,
  name_ar         text NOT NULL,
  interval_days   integer NOT NULL CHECK (interval_days BETWEEN 1 AND 3650),
  next_due_date   date NOT NULL,
  last_done_date  date,
  checklist       text,
  is_active       boolean NOT NULL DEFAULT true,
  created_by      uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fixed_assets(tenant_id, id)
);

CREATE TYPE wo_kind AS ENUM ('preventive', 'corrective');
CREATE TYPE wo_priority AS ENUM ('low', 'normal', 'high', 'critical');
CREATE TYPE wo_status AS ENUM ('open', 'in_progress', 'completed', 'cancelled');

CREATE TABLE maintenance_orders (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  company_id           uuid NOT NULL,
  number               text NOT NULL,
  asset_id             uuid NOT NULL,
  plan_id              uuid,
  kind                 wo_kind NOT NULL,
  priority             wo_priority NOT NULL DEFAULT 'normal',
  status               wo_status NOT NULL DEFAULT 'open',
  failure_code         text,
  description          text NOT NULL,
  reported_at          timestamptz NOT NULL DEFAULT now(),
  started_at           timestamptz,
  completed_at         timestamptz,
  completion_date      date,
  downtime_minutes     integer NOT NULL DEFAULT 0 CHECK (downtime_minutes >= 0),
  warehouse_id         uuid,                 -- spare parts are issued from here
  external_cost        numeric(20,4) NOT NULL DEFAULT 0 CHECK (external_cost >= 0),
  external_account_id  uuid,                 -- credit side of external cost (AP, cash, bank)
  expense_account_id   uuid,                 -- resolved at completion
  parts_cost           numeric(20,4) NOT NULL DEFAULT 0,
  total_cost           numeric(20,4) NOT NULL DEFAULT 0,
  resolution           text,
  journal_entry_id     uuid,
  created_by           uuid,
  completed_by         uuid,
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, number),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fixed_assets(tenant_id, id),
  FOREIGN KEY (tenant_id, plan_id) REFERENCES maintenance_plans(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, external_account_id) REFERENCES accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, expense_account_id) REFERENCES accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries(tenant_id, id),
  CHECK (kind = 'corrective' OR plan_id IS NOT NULL),
  CHECK (external_cost = 0 OR external_account_id IS NOT NULL)
);
-- at most one open order per preventive plan (generation is idempotent)
CREATE UNIQUE INDEX uq_maintenance_open_per_plan ON maintenance_orders (plan_id) WHERE status IN ('open', 'in_progress');
CREATE INDEX ix_maintenance_orders_asset ON maintenance_orders (asset_id, reported_at);

CREATE TABLE maintenance_parts (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  order_id  uuid NOT NULL,
  item_id   uuid NOT NULL,
  uom_id    uuid NOT NULL,
  qty       numeric(20,6) NOT NULL CHECK (qty > 0),
  base_qty  numeric(20,6) NOT NULL CHECK (base_qty > 0),
  value     numeric(20,4),                 -- cost at issue (filled at completion)
  FOREIGN KEY (tenant_id, order_id) REFERENCES maintenance_orders(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id),
  FOREIGN KEY (tenant_id, uom_id) REFERENCES uoms(tenant_id, id)
);

CREATE OR REPLACE FUNCTION trg_wo_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'maintenance orders cannot be deleted; cancel instead'; END IF;
  IF OLD.status IN ('completed', 'cancelled') THEN RAISE EXCEPTION 'maintenance order is % and immutable', OLD.status; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wo_guard BEFORE UPDATE OR DELETE ON maintenance_orders FOR EACH ROW EXECUTE FUNCTION trg_wo_guard();

CREATE OR REPLACE FUNCTION trg_wo_parts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st wo_status;
BEGIN
  SELECT status INTO st FROM maintenance_orders WHERE id = COALESCE(NEW.order_id, OLD.order_id);
  IF st IN ('completed', 'cancelled') THEN RAISE EXCEPTION 'parts of a closed maintenance order are immutable'; END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER wo_parts_guard BEFORE INSERT OR UPDATE OR DELETE ON maintenance_parts FOR EACH ROW EXECUTE FUNCTION trg_wo_parts_guard();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['asset_categories','fixed_assets','depreciation_runs','depreciation_lines','maintenance_plans','maintenance_orders','maintenance_parts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY p_tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO golden_app', t);
  END LOOP;
END $$;

INSERT INTO permissions (code, module_code, name_ar, name_en, is_sensitive) VALUES
  ('assets.register.view',        'assets', 'عرض سجل الأصول', 'View asset register', false),
  ('assets.register.manage',      'assets', 'إدارة فئات وبطاقات الأصول (مسودات)', 'Manage asset categories & cards (drafts)', false),
  ('assets.register.capitalize',  'assets', 'رسملة الأصول وترحيل قيدها', 'Capitalize assets (posts GL)', true),
  ('assets.depreciation.prepare', 'assets', 'إعداد دورة الإهلاك', 'Prepare depreciation runs', false),
  ('assets.depreciation.post',    'assets', 'ترحيل الإهلاك', 'Post depreciation', true),
  ('assets.register.dispose',     'assets', 'استبعاد/بيع الأصول', 'Dispose of assets', true),
  ('assets.maintenance.view',     'assets', 'عرض الصيانة', 'View maintenance', false),
  ('assets.maintenance.manage',   'assets', 'خطط وأوامر الصيانة والأعطال', 'Maintenance plans, orders & breakdowns', false),
  ('assets.maintenance.complete', 'assets', 'إقفال أمر الصيانة (صرف قطع الغيار وترحيل التكلفة)', 'Complete maintenance orders (issue parts, post cost)', false);
