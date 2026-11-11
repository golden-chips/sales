-- =====================================================================
-- GOLDEN ERP — Migration 009: self-service trials & upgrade requests
-- =====================================================================
ALTER TABLE plans ADD COLUMN is_trial_default boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX uq_plans_trial_default ON plans(is_trial_default) WHERE is_trial_default;

ALTER TABLE tenants ADD COLUMN signup_source text NOT NULL DEFAULT 'platform' CHECK (signup_source IN ('platform', 'self_signup')),
                    ADD COLUMN contact_phone text;

CREATE TYPE upgrade_status AS ENUM ('open', 'done', 'rejected');
CREATE TABLE upgrade_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  plan_code     text NOT NULL REFERENCES plans(code),
  billing_cycle billing_cycle NOT NULL DEFAULT 'monthly',
  note          text,
  contact_phone text,
  status        upgrade_status NOT NULL DEFAULT 'open',
  requested_by  uuid NOT NULL,
  handled_by    uuid REFERENCES platform_users(id),
  handled_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES users(tenant_id, id)
);
-- one open request per tenant at a time
CREATE UNIQUE INDEX uq_upgrade_requests_open ON upgrade_requests(tenant_id) WHERE status = 'open';
ALTER TABLE upgrade_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE upgrade_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY p_upgrade_tenant ON upgrade_requests USING (app_is_platform() OR tenant_id = app_tenant_id())
  WITH CHECK (app_is_platform() OR tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE ON upgrade_requests TO golden_app;

-- public signup must know whether a company code is free without seeing any tenant data
CREATE OR REPLACE FUNCTION tenant_code_available(p_code text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT NOT EXISTS (SELECT 1 FROM tenants WHERE code = lower(p_code))
$$;
GRANT EXECUTE ON FUNCTION tenant_code_available(text) TO golden_app;

-- public pricing page reads public plans only
CREATE OR REPLACE FUNCTION public_plans() RETURNS TABLE (code text, name_ar text, name_en text, currency char(3), price_monthly numeric, price_yearly numeric,
  trial_days int, max_users int, max_branches int, max_warehouses int, is_trial_default boolean, modules text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.code, p.name_ar, p.name_en, p.currency, p.price_monthly, p.price_yearly, p.trial_days, p.max_users, p.max_branches, p.max_warehouses, p.is_trial_default,
         ARRAY(SELECT module_code FROM plan_modules m WHERE m.plan_id = p.id ORDER BY 1)
    FROM plans p WHERE p.is_active AND p.is_public ORDER BY p.price_monthly, p.max_users
$$;
GRANT EXECUTE ON FUNCTION public_plans() TO golden_app;
