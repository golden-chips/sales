-- =====================================================================
-- GOLDEN ERP — Migration 012: BI & reporting (Phase 6c)
-- Dashboards are computed live from the transactional tables (no copy of
-- the data). Stored here: threshold alert rules and report schedules
-- (delivered through the notification outbox).
-- =====================================================================

CREATE TABLE bi_alert_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  company_id  uuid NOT NULL,
  name_ar     text NOT NULL,
  area        text NOT NULL CHECK (area IN ('executive','financial','sales','inventory','manufacturing','procurement','hr','distribution','quality')),
  metric      text NOT NULL CHECK (metric ~ '^[a-z_]{2,60}$'),
  operator    text NOT NULL CHECK (operator IN ('gt', 'lt')),
  threshold   numeric(20,4) NOT NULL,
  recipient   text,                        -- e-mail / phone for the outbox (optional)
  is_active   boolean NOT NULL DEFAULT true,
  last_triggered_at timestamptz,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id)
);

CREATE TABLE bi_report_schedules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  company_id  uuid NOT NULL,
  area        text NOT NULL CHECK (area IN ('executive','financial','sales','inventory','manufacturing','procurement','hr','distribution','quality')),
  frequency   text NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  recipient   text NOT NULL CHECK (recipient ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  is_active   boolean NOT NULL DEFAULT true,
  next_run_on date NOT NULL,
  last_run_at timestamptz,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bi_alert_rules','bi_report_schedules'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY p_tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO golden_app', t);
  END LOOP;
END $$;

INSERT INTO permissions (code, module_code, name_ar, name_en, is_sensitive) VALUES
  ('bi.dashboards.view', 'bi', 'لوحات التحليل (كل لوحة تتطلب أيضًا صلاحية عرض وحدتها)', 'Dashboards (each also requires the view permission of its area)', false),
  ('bi.executive.view',  'bi', 'اللوحة التنفيذية (أرقام مالية شاملة)', 'Executive dashboard (company-wide financial figures)', true),
  ('bi.alerts.manage',   'bi', 'قواعد التنبيه وجدولة التقارير', 'Alert rules & report schedules', false);
