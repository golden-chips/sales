-- =====================================================================
-- GOLDEN ERP — Migration 006: Manufacturing & Quality (Phase 3)
-- * Versioned formulas / BOMs (draft → approved → archived; one approved
--   version per product), standard scrap %, approved substitutes
-- * Work centers (production lines) with an hourly conversion-cost rate
-- * Production orders: draft → released → in_progress → completed
--   (actual costing through WIP; finished output lands in QUARANTINE)
-- * Production entries: material issue / return, labour & overhead
-- * Quality: per-item specs (incl. HACCP critical control points),
--   checks with measured results, non-conformance (CAPA), recalls
-- * Rule: quarantine release of a tracked lot requires a PASSED final check
-- =====================================================================

CREATE TYPE bom_status AS ENUM ('draft', 'approved', 'archived');

CREATE TABLE boms (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  company_id     uuid NOT NULL,
  item_id        uuid NOT NULL,                 -- product made
  version        int NOT NULL CHECK (version > 0),
  status         bom_status NOT NULL DEFAULT 'draft',
  batch_qty      numeric(20,4) NOT NULL CHECK (batch_qty > 0),   -- output per batch, base unit
  std_scrap_pct  numeric(7,4) NOT NULL DEFAULT 0 CHECK (std_scrap_pct BETWEEN 0 AND 100), -- expected output loss
  std_hours      numeric(10,4) NOT NULL DEFAULT 0 CHECK (std_hours >= 0),                  -- line hours per batch
  notes          text,
  created_by     uuid NOT NULL,
  approved_by    uuid,
  approved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (item_id, version),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES users(tenant_id, id),
  CHECK ((status = 'draft') = (approved_by IS NULL))
);
CREATE UNIQUE INDEX uq_boms_one_approved ON boms(item_id) WHERE status = 'approved';

CREATE TABLE bom_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  bom_id             uuid NOT NULL,
  line_no            smallint NOT NULL,
  item_id            uuid NOT NULL,                       -- raw material / packaging / semi-finished
  qty                numeric(20,6) NOT NULL CHECK (qty > 0), -- per batch, base unit of the component
  scrap_pct          numeric(7,4) NOT NULL DEFAULT 0 CHECK (scrap_pct BETWEEN 0 AND 100),
  substitute_item_id uuid,                                 -- approved alternative
  UNIQUE (bom_id, line_no),
  FOREIGN KEY (tenant_id, bom_id) REFERENCES boms(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id),
  FOREIGN KEY (tenant_id, substitute_item_id) REFERENCES items(tenant_id, id),
  CHECK (substitute_item_id IS NULL OR substitute_item_id <> item_id)
);

-- an approved/archived formula is frozen: change = new version
CREATE OR REPLACE FUNCTION bom_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s bom_status;
BEGIN
  IF TG_TABLE_NAME = 'boms' THEN
    IF TG_OP = 'DELETE' THEN
      IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'approved formulas cannot be deleted; archive them' USING ERRCODE = 'P0001'; END IF;
      RETURN OLD;
    END IF;
    IF OLD.status <> 'draft' AND (NEW.batch_qty, NEW.std_scrap_pct, NEW.std_hours, NEW.item_id, NEW.version) IS DISTINCT FROM (OLD.batch_qty, OLD.std_scrap_pct, OLD.std_hours, OLD.item_id, OLD.version) THEN
      RAISE EXCEPTION 'approved formulas are frozen; create a new version' USING ERRCODE = 'P0001';
    END IF;
    IF OLD.status = 'archived' AND NEW.status <> 'archived' THEN RAISE EXCEPTION 'archived formulas cannot be reactivated' USING ERRCODE = 'P0001'; END IF;
    RETURN NEW;
  END IF;
  SELECT status INTO s FROM boms WHERE id = coalesce(NEW.bom_id, OLD.bom_id);
  IF s IS NOT NULL AND s <> 'draft' THEN RAISE EXCEPTION 'lines of an approved formula are frozen' USING ERRCODE = 'P0001'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_boms_guard BEFORE UPDATE OR DELETE ON boms FOR EACH ROW EXECUTE FUNCTION bom_guard();
CREATE TRIGGER trg_bom_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON bom_lines FOR EACH ROW EXECUTE FUNCTION bom_guard();

CREATE TABLE work_centers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  company_id        uuid NOT NULL,
  branch_id         uuid,
  code              text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{1,20}$'),
  name_ar           text NOT NULL,
  name_en           text,
  capacity_per_hour numeric(20,4) CHECK (capacity_per_hour > 0),   -- base units of output
  rate_per_hour     numeric(20,4) NOT NULL DEFAULT 0 CHECK (rate_per_hour >= 0), -- labour + energy + overhead absorbed per line hour
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, code),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id)
);

CREATE TYPE mo_status AS ENUM ('draft', 'released', 'in_progress', 'completed', 'cancelled');

CREATE TABLE production_orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  company_id          uuid NOT NULL,
  number              text,
  item_id             uuid NOT NULL,
  bom_id              uuid NOT NULL,
  work_center_id      uuid,
  planned_qty         numeric(20,4) NOT NULL CHECK (planned_qty > 0),
  material_warehouse_id uuid NOT NULL,               -- issue raw/packaging from here
  output_warehouse_id uuid NOT NULL,                 -- must be a quarantine warehouse (QC before sale)
  planned_date        date NOT NULL,
  status              mo_status NOT NULL DEFAULT 'draft',
  std_unit_cost       numeric(20,6),                 -- standard cost roll-up frozen at release
  produced_qty        numeric(20,4),
  scrap_qty           numeric(20,4),
  output_lot_id       uuid,
  actual_cost         numeric(20,4),
  started_at          timestamptz,
  completed_at        timestamptz,
  notes               text,
  created_by          uuid NOT NULL,
  released_by         uuid,
  completed_by        uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, number),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id),
  FOREIGN KEY (tenant_id, bom_id) REFERENCES boms(tenant_id, id),
  FOREIGN KEY (tenant_id, work_center_id) REFERENCES work_centers(tenant_id, id),
  FOREIGN KEY (tenant_id, material_warehouse_id) REFERENCES warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, output_warehouse_id) REFERENCES warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, output_lot_id) REFERENCES lots(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, released_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, completed_by) REFERENCES users(tenant_id, id),
  CHECK (status <> 'completed' OR (produced_qty IS NOT NULL AND actual_cost IS NOT NULL))
);
CREATE TRIGGER trg_production_orders_upd BEFORE UPDATE ON production_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION mo_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'only draft production orders can be deleted' USING ERRCODE = 'P0001'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('completed', 'cancelled') THEN RAISE EXCEPTION 'production order is % and immutable', OLD.status USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_mo_guard BEFORE UPDATE OR DELETE ON production_orders FOR EACH ROW EXECUTE FUNCTION mo_guard();

CREATE TYPE production_entry_kind AS ENUM ('issue', 'return', 'conversion');

-- executed on the shop floor; each entry posts its stock move + journal immediately (append-only)
CREATE TABLE production_entries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  order_id         uuid NOT NULL,
  kind             production_entry_kind NOT NULL,
  entry_date       date NOT NULL,
  item_id          uuid,                    -- issue/return
  lot_id           uuid,
  qty              numeric(20,4),
  hours            numeric(10,4),           -- conversion
  value            numeric(20,4) NOT NULL CHECK (value >= 0),
  journal_entry_id uuid,
  notes            text,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES production_orders(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id),
  FOREIGN KEY (tenant_id, lot_id) REFERENCES lots(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  CHECK ((kind = 'conversion') = (hours IS NOT NULL)),
  CHECK (kind = 'conversion' OR (item_id IS NOT NULL AND qty > 0))
);
CREATE INDEX ix_production_entries_order ON production_entries(order_id);
CREATE INDEX ix_production_entries_lot ON production_entries(lot_id) WHERE lot_id IS NOT NULL;
CREATE TRIGGER trg_production_entries_append_only BEFORE UPDATE OR DELETE ON production_entries FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------
-- Quality
-- ---------------------------------------------------------------------
CREATE TYPE qc_stage AS ENUM ('receiving', 'in_process', 'final', 'return');
CREATE TYPE qc_result AS ENUM ('pass', 'fail');

CREATE TABLE quality_specs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  item_id    uuid NOT NULL,
  stage      qc_stage NOT NULL,
  parameter  text NOT NULL,
  unit       text,
  min_value  numeric(20,6),
  max_value  numeric(20,6),
  is_ccp     boolean NOT NULL DEFAULT false,   -- HACCP critical control point: any failure = lot fails
  UNIQUE (tenant_id, id),
  UNIQUE (item_id, stage, parameter),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id),
  CHECK (min_value IS NULL OR max_value IS NULL OR min_value <= max_value)
);

CREATE TABLE quality_checks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  company_id          uuid NOT NULL,
  number              text NOT NULL,
  lot_id              uuid NOT NULL,
  stage               qc_stage NOT NULL,
  production_order_id uuid,
  result              qc_result NOT NULL,
  sample_size         text,
  notes               text,
  checked_by          uuid NOT NULL,
  checked_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, number),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, lot_id) REFERENCES lots(tenant_id, id),
  FOREIGN KEY (tenant_id, production_order_id) REFERENCES production_orders(tenant_id, id),
  FOREIGN KEY (tenant_id, checked_by) REFERENCES users(tenant_id, id)
);
CREATE INDEX ix_quality_checks_lot ON quality_checks(lot_id, checked_at DESC);
CREATE TRIGGER trg_quality_checks_append_only BEFORE UPDATE OR DELETE ON quality_checks FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE quality_check_results (
  tenant_id  uuid NOT NULL,
  check_id   uuid NOT NULL,
  parameter  text NOT NULL,
  unit       text,
  min_value  numeric(20,6),
  max_value  numeric(20,6),
  value      numeric(20,6),
  text_value text,
  is_ccp     boolean NOT NULL DEFAULT false,
  passed     boolean NOT NULL,
  PRIMARY KEY (check_id, parameter),
  FOREIGN KEY (tenant_id, check_id) REFERENCES quality_checks(tenant_id, id)
);
CREATE TRIGGER trg_qc_results_append_only BEFORE UPDATE OR DELETE ON quality_check_results FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TYPE ncr_disposition AS ENUM ('rework', 'scrap', 'return_to_supplier', 'use_as_is', 'pending');
CREATE TYPE ncr_status AS ENUM ('open', 'closed');

CREATE TABLE nonconformances (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  company_id        uuid NOT NULL,
  number            text NOT NULL,
  lot_id            uuid,
  check_id          uuid,
  description       text NOT NULL,
  root_cause        text,
  disposition       ncr_disposition NOT NULL DEFAULT 'pending',
  corrective_action text,
  preventive_action text,
  status            ncr_status NOT NULL DEFAULT 'open',
  created_by        uuid NOT NULL,
  closed_by         uuid,
  closed_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, number),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, lot_id) REFERENCES lots(tenant_id, id),
  FOREIGN KEY (tenant_id, check_id) REFERENCES quality_checks(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, closed_by) REFERENCES users(tenant_id, id),
  CHECK (status = 'open' OR (disposition <> 'pending' AND corrective_action IS NOT NULL AND closed_by IS NOT NULL))
);

CREATE TYPE recall_status AS ENUM ('open', 'closed');
CREATE TABLE recalls (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  company_id  uuid NOT NULL,
  number      text NOT NULL,
  lot_id      uuid NOT NULL,                 -- the lot that triggered the recall (raw or finished)
  reason      text NOT NULL,
  status      recall_status NOT NULL DEFAULT 'open',
  snapshot    jsonb NOT NULL,                -- trace result at the moment of the recall (evidence)
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, number),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, lot_id) REFERENCES lots(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id)
);

-- RLS + grants
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['boms','bom_lines','work_centers','production_orders','production_entries','quality_specs','quality_checks',
                           'quality_check_results','nonconformances','recalls'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY p_tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO golden_app', t);
  END LOOP;
END $$;
REVOKE UPDATE, DELETE ON production_entries, quality_checks, quality_check_results FROM golden_app;

INSERT INTO permissions (code, module_code, name_ar, name_en, is_sensitive) VALUES
  ('manufacturing.boms.view',       'manufacturing', 'عرض الوصفات وقوائم المواد', 'View formulas / BOMs', false),
  ('manufacturing.boms.manage',     'manufacturing', 'إنشاء وتعديل الوصفات', 'Create & edit formulas', false),
  ('manufacturing.boms.approve',    'manufacturing', 'اعتماد إصدارات الوصفات', 'Approve formula versions', true),
  ('manufacturing.orders.view',     'manufacturing', 'عرض أوامر الإنتاج وتقارير التكلفة', 'View production orders & costing', false),
  ('manufacturing.orders.manage',   'manufacturing', 'إنشاء أوامر الإنتاج ومراكز العمل', 'Create production orders & work centers', false),
  ('manufacturing.orders.release',  'manufacturing', 'تحرير أوامر الإنتاج', 'Release production orders', true),
  ('manufacturing.orders.complete', 'manufacturing', 'إغلاق أوامر الإنتاج واحتساب التكلفة', 'Complete orders & cost output', true),
  ('manufacturing.execution.issue', 'manufacturing', 'صرف وإرجاع المواد للإنتاج', 'Issue / return materials', false),
  ('manufacturing.execution.time',  'manufacturing', 'تسجيل ساعات التشغيل', 'Record line hours', false),
  ('manufacturing.planning.view',   'manufacturing', 'تخطيط الاحتياجات (MRP)', 'Material requirements planning', false),
  ('quality.view',                  'quality', 'عرض الجودة والتتبع', 'View quality & traceability', false),
  ('quality.specs.manage',          'quality', 'إدارة مواصفات الجودة ونقاط التحكم الحرجة', 'Manage specs & CCPs', false),
  ('quality.checks.create',         'quality', 'تسجيل الفحوصات', 'Record quality checks', false),
  ('quality.ncr.manage',            'quality', 'حالات عدم المطابقة والإجراءات التصحيحية', 'Non-conformance & CAPA', false),
  ('quality.recall.manage',         'quality', 'إدارة الاستدعاء', 'Manage product recalls', true);

-- lot hold: set by a failed quality check or a recall; a held lot can never be sold or released
ALTER TABLE lots ADD COLUMN on_hold boolean NOT NULL DEFAULT false, ADD COLUMN hold_reason text;
