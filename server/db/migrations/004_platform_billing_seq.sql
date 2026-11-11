-- GOLDEN ERP — Migration 004: platform invoice numbering + coupons
CREATE SEQUENCE platform_invoice_seq START 1;
GRANT USAGE, SELECT ON SEQUENCE platform_invoice_seq TO golden_app;

CREATE TABLE coupons (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_-]{3,30}$'),
  percent_off  numeric(5,2) NOT NULL CHECK (percent_off > 0 AND percent_off <= 100),
  valid_until  timestamptz,
  max_redemptions int CHECK (max_redemptions > 0),
  redemptions  int NOT NULL DEFAULT 0,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (max_redemptions IS NULL OR redemptions <= max_redemptions)
);
ALTER TABLE coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupons FORCE ROW LEVEL SECURITY;
CREATE POLICY p_coupons ON coupons USING (app_is_platform()) WITH CHECK (app_is_platform());
GRANT SELECT, INSERT, UPDATE ON coupons TO golden_app;

ALTER TABLE platform_invoices ADD COLUMN coupon_id uuid REFERENCES coupons(id);

-- Platform staff can revoke a tenant's sessions (suspension) without being
-- able to read the tenant's refresh tokens or any other tenant data.
CREATE OR REPLACE FUNCTION platform_revoke_tenant_sessions(p_tenant uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n bigint;
BEGIN
  IF NOT app_is_platform() THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  UPDATE refresh_tokens SET revoked_at = now() WHERE tenant_id = p_tenant AND revoked_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
GRANT EXECUTE ON FUNCTION platform_revoke_tenant_sessions(uuid) TO golden_app;
