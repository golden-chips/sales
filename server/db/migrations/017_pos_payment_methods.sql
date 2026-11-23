-- =====================================================================
-- GOLDEN ERP — Migration 017: POS payment methods
--   Several card / wallet / transfer methods per company (e.g. one per bank
--   or e-wallet), each settled to its own GL account, optionally limited to
--   named cashiers. Additive only: the register's single card account keeps
--   working for existing sales; pos_payments gains an optional method_id.
-- =====================================================================

CREATE TYPE pos_method_kind AS ENUM ('card', 'wallet', 'transfer');

CREATE TABLE pos_payment_methods (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  company_id  uuid NOT NULL,
  name_ar     text NOT NULL CHECK (length(name_ar) BETWEEN 2 AND 60),
  kind        pos_method_kind NOT NULL DEFAULT 'card',
  account_id  uuid NOT NULL,                 -- bank / card clearing / wallet account it settles to
  sort_order  smallint NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, name_ar),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts(tenant_id, id)
);

-- no rows for a method = every cashier may use it; rows = only these users
CREATE TABLE pos_payment_method_users (
  tenant_id  uuid NOT NULL,
  method_id  uuid NOT NULL,
  user_id    uuid NOT NULL,
  PRIMARY KEY (method_id, user_id),
  FOREIGN KEY (tenant_id, method_id) REFERENCES pos_payment_methods(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
);

ALTER TABLE pos_payments ADD COLUMN method_id uuid, ADD FOREIGN KEY (tenant_id, method_id) REFERENCES pos_payment_methods(tenant_id, id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pos_payment_methods', 'pos_payment_method_users'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY p_tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO golden_app', t);
  END LOOP;
END $$;
