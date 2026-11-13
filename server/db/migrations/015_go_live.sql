-- =====================================================================
-- GOLDEN ERP — Migration 015: go-live (Phase 7)
--  * opening receivables / payables as real open documents, so ageing,
--    statements and receipt allocation agree with the GL from day one
--  * go-live sign-offs (chart of accounts, opening balances, UAT)
--  * user acceptance test results
-- =====================================================================

-- opening documents carry no stock: no warehouse / goods receipt
ALTER TABLE sales_invoices ADD COLUMN is_opening boolean NOT NULL DEFAULT false, ADD COLUMN opening_reference text;
ALTER TABLE sales_invoices ALTER COLUMN warehouse_id DROP NOT NULL;
ALTER TABLE sales_invoices ADD CONSTRAINT sales_invoices_opening_wh CHECK (is_opening OR warehouse_id IS NOT NULL);
ALTER TABLE supplier_invoices ADD COLUMN is_opening boolean NOT NULL DEFAULT false;
ALTER TABLE supplier_invoices ALTER COLUMN receipt_id DROP NOT NULL;
ALTER TABLE supplier_invoices ADD CONSTRAINT supplier_invoices_opening_receipt CHECK (is_opening OR receipt_id IS NOT NULL);

CREATE TABLE go_live_signoffs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  company_id  uuid NOT NULL,
  item        text NOT NULL CHECK (item IN ('chart_of_accounts', 'opening_balances', 'uat', 'go_live')),
  approved_by uuid NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  note        text,
  evidence    jsonb,                          -- e.g. the reconciliation figures at the moment of sign-off
  revoked_at  timestamptz,
  revoked_by  uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES users(tenant_id, id)
);
CREATE UNIQUE INDEX uq_go_live_signoff_active ON go_live_signoffs (company_id, item) WHERE revoked_at IS NULL;

CREATE TYPE uat_status AS ENUM ('pass', 'fail', 'blocked');
CREATE TABLE uat_results (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  company_id   uuid NOT NULL,
  scenario_key text NOT NULL CHECK (scenario_key ~ '^[a-z0-9_.-]{2,60}$'),
  status       uat_status NOT NULL,
  notes        text,
  tester_id    uuid NOT NULL,
  tested_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, tester_id) REFERENCES users(tenant_id, id),
  CHECK (status = 'pass' OR notes IS NOT NULL)   -- a failure must say what went wrong
);
CREATE INDEX ix_uat_results ON uat_results (company_id, scenario_key, tested_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['go_live_signoffs','uat_results'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY p_tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO golden_app', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE uat_results_id_seq TO golden_app;

INSERT INTO permissions (code, module_code, name_ar, name_en, is_sensitive) VALUES
  ('core.golive.view',   'core', 'جاهزية التشغيل والمطابقات', 'Go-live readiness & reconciliations', false),
  ('core.golive.manage', 'core', 'اعتماد مراحل التشغيل (الإطلاق الفعلي)', 'Sign off go-live stages', true),
  ('core.uat.record',    'core', 'تسجيل نتائج اختبارات القبول', 'Record user acceptance test results', false);
