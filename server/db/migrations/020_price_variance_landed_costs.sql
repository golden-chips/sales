-- =====================================================================
-- GOLDEN ERP — Migration 020: purchase price variance & landed costs (K14)
-- Additive only.
--   * A supplier invoice marked "final" for its receipt may differ from the
--     receipt's uninvoiced value; the difference is the price variance.
--   * Landed cost: shipping, customs, loading… added to a posted receipt,
--     split by value or by quantity.
--   Both raise (or lower) the value of the goods still on hand in the
--   receiving warehouse; the share of goods already used goes to stock
--   differences. Stock value changes without quantity are kept in an
--   append-only log so every balance can be traced.
-- =====================================================================

ALTER TABLE supplier_invoices
  ADD COLUMN is_final boolean NOT NULL DEFAULT false,
  ADD COLUMN price_variance numeric(20,4) NOT NULL DEFAULT 0;

CREATE TYPE landed_split AS ENUM ('value', 'qty');

CREATE TABLE landed_costs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  company_id        uuid NOT NULL,
  receipt_id        uuid NOT NULL,
  number            text,
  status            doc_status NOT NULL DEFAULT 'draft',
  cost_date         date NOT NULL,
  description       text NOT NULL CHECK (length(description) >= 3),
  amount            numeric(20,4) NOT NULL CHECK (amount > 0),
  split             landed_split NOT NULL DEFAULT 'value',
  credit_account_id uuid NOT NULL,            -- paid from cash / bank, or an accrual account
  capitalized       numeric(20,4),            -- part added to stock still on hand
  expensed          numeric(20,4),            -- part for goods already used
  journal_entry_id  uuid,
  created_by        uuid NOT NULL,
  posted_by         uuid,
  posted_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, number),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES purchase_receipts(tenant_id, id),
  FOREIGN KEY (tenant_id, credit_account_id) REFERENCES accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries(tenant_id, id)
);
CREATE TRIGGER trg_landed_costs_guard BEFORE UPDATE OR DELETE ON landed_costs FOR EACH ROW EXECUTE FUNCTION doc_status_guard();
CREATE TRIGGER trg_landed_costs_upd BEFORE UPDATE ON landed_costs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- value-only changes of a warehouse+item balance (append-only)
CREATE TABLE stock_value_adjustments (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  company_id   uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  item_id      uuid NOT NULL,
  adj_date     date NOT NULL,
  value        numeric(20,4) NOT NULL CHECK (value <> 0),
  source_type  text NOT NULL,
  source_id    uuid NOT NULL,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id)
);
CREATE INDEX ix_stock_value_adj_item ON stock_value_adjustments (item_id, warehouse_id);
CREATE TRIGGER trg_stock_value_adj_append_only BEFORE UPDATE OR DELETE ON stock_value_adjustments FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['landed_costs', 'stock_value_adjustments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY p_tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO golden_app', t);
  END LOOP;
  EXECUTE 'GRANT USAGE ON SEQUENCE stock_value_adjustments_id_seq TO golden_app';
END $$;

INSERT INTO permissions (code, module_code, name_ar, name_en, is_sensitive) VALUES
  ('purchasing.landed.create', 'purchasing', 'تسجيل التكاليف الإضافية للمشتريات (شحن، جمارك)', 'Record landed costs', false),
  ('purchasing.landed.post',   'purchasing', 'ترحيل التكاليف الإضافية للمشتريات', 'Post landed costs', true);
