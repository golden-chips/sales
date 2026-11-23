-- =====================================================================
-- GOLDEN ERP — Migration 022: fingerprint device address allow-list (K26). Additive.
--   Devices cannot authenticate (iclock/ADMS sends only a serial number), so a device
--   can optionally be limited to the factory's public address(es).
-- =====================================================================
ALTER TABLE attendance_devices ADD COLUMN allowed_ips cidr[] NOT NULL DEFAULT '{}';

-- lookup used by the push endpoint (no tenant context yet) — also reports whether the caller's address is allowed
CREATE FUNCTION device_for_push(p_sn text, p_ip inet)
RETURNS TABLE (id uuid, tenant_id uuid, company_id uuid, is_active boolean, ip_allowed boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT d.id, d.tenant_id, d.company_id, d.is_active,
         cardinality(d.allowed_ips) = 0 OR EXISTS (SELECT 1 FROM unnest(d.allowed_ips) a WHERE p_ip <<= a)
    FROM attendance_devices d WHERE d.serial_number = p_sn
$$;
GRANT EXECUTE ON FUNCTION device_for_push(text, inet) TO golden_app;
