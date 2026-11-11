-- =====================================================================
-- GOLDEN ERP — Migration 011: Point of sale (Phase 6b)
-- A POS sale IS a sales invoice (same stock, FEFO, lot trace, receivables,
-- statements and analysis) linked to a cashier shift. Payments (cash, card,
-- on account) are recorded per shift so the drawer can be reconciled:
--   expected cash = opening float + cash sales − cash refunds − cash drops.
-- The drawer account is emptied at every close (counted cash back to the
-- main safe, the difference to the variance account).
-- =====================================================================

CREATE TABLE pos_registers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  company_id          uuid NOT NULL,
  branch_id           uuid NOT NULL,
  code                text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{1,20}$'),
  name_ar             text NOT NULL,
  warehouse_id        uuid NOT NULL,          -- sellable stock the register sells from
  return_warehouse_id uuid NOT NULL,          -- quarantine: returned food never goes straight back on sale
  walk_in_customer_id uuid NOT NULL,          -- "cash customer" used when no customer is chosen
  cash_account_id     uuid NOT NULL,          -- drawer (role pos_cash by default)
  safe_account_id     uuid NOT NULL,          -- main safe: float comes from here, counted cash goes back
  card_account_id     uuid,                   -- bank / card clearing
  variance_account_id uuid,                   -- cash over/short
  max_discount_pct    numeric(5,2) NOT NULL DEFAULT 0 CHECK (max_discount_pct BETWEEN 0 AND 100),
  receipt_header      text,
  receipt_footer      text,
  is_active           boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, code),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, return_warehouse_id) REFERENCES warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, walk_in_customer_id) REFERENCES parties(tenant_id, id),
  FOREIGN KEY (tenant_id, cash_account_id) REFERENCES accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, safe_account_id) REFERENCES accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, card_account_id) REFERENCES accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, variance_account_id) REFERENCES accounts(tenant_id, id),
  CHECK (cash_account_id <> safe_account_id)
);

CREATE TYPE pos_shift_status AS ENUM ('open', 'closed');

CREATE TABLE pos_shifts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  company_id       uuid NOT NULL,
  register_id      uuid NOT NULL,
  number           text NOT NULL,
  cashier_id       uuid NOT NULL,
  status           pos_shift_status NOT NULL DEFAULT 'open',
  opened_at        timestamptz NOT NULL DEFAULT now(),
  business_date    date NOT NULL,
  opening_float    numeric(20,4) NOT NULL DEFAULT 0 CHECK (opening_float >= 0),
  closed_at        timestamptz,
  closed_by        uuid,
  expected_cash    numeric(20,4),
  counted_cash     numeric(20,4) CHECK (counted_cash >= 0),
  variance         numeric(20,4),
  close_notes      text,
  open_journal_id  uuid,
  close_journal_id uuid,
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, number),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, register_id) REFERENCES pos_registers(tenant_id, id),
  FOREIGN KEY (tenant_id, cashier_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, open_journal_id) REFERENCES journal_entries(tenant_id, id),
  FOREIGN KEY (tenant_id, close_journal_id) REFERENCES journal_entries(tenant_id, id),
  CHECK (status = 'open' OR (counted_cash IS NOT NULL AND expected_cash IS NOT NULL AND variance = counted_cash - expected_cash))
);
-- one open shift per register and per cashier
CREATE UNIQUE INDEX uq_pos_open_shift_register ON pos_shifts (register_id) WHERE status = 'open';
CREATE UNIQUE INDEX uq_pos_open_shift_cashier ON pos_shifts (cashier_id) WHERE status = 'open';

CREATE OR REPLACE FUNCTION trg_pos_shift_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'POS shifts cannot be deleted'; END IF;
  IF OLD.status = 'closed' THEN RAISE EXCEPTION 'a closed POS shift is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pos_shift_guard BEFORE UPDATE OR DELETE ON pos_shifts FOR EACH ROW EXECUTE FUNCTION trg_pos_shift_guard();

CREATE TYPE pos_movement AS ENUM ('sale', 'refund', 'drop');
CREATE TYPE pos_tender AS ENUM ('cash', 'card', 'credit');

-- every money movement of a shift (append-only)
CREATE TABLE pos_payments (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  shift_id    uuid NOT NULL,
  kind        pos_movement NOT NULL,
  tender      pos_tender NOT NULL,
  amount      numeric(20,4) NOT NULL,          -- signed: + into the drawer / account, − out
  invoice_id  uuid,
  return_id   uuid,
  note        text,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES pos_shifts(tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES sales_invoices(tenant_id, id),
  FOREIGN KEY (tenant_id, return_id) REFERENCES sales_returns(tenant_id, id)
);
CREATE INDEX ix_pos_payments_shift ON pos_payments (shift_id);

CREATE OR REPLACE FUNCTION trg_pos_payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st pos_shift_status;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'POS payments are append-only'; END IF;
  SELECT status INTO st FROM pos_shifts WHERE id = NEW.shift_id;
  IF st <> 'open' THEN RAISE EXCEPTION 'the POS shift is closed'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pos_payment_guard BEFORE INSERT OR UPDATE OR DELETE ON pos_payments FOR EACH ROW EXECUTE FUNCTION trg_pos_payment_guard();

-- the sale document is the sales invoice itself
ALTER TABLE sales_invoices ADD COLUMN pos_shift_id uuid, ADD COLUMN pos_client_id text,
  ADD FOREIGN KEY (tenant_id, pos_shift_id) REFERENCES pos_shifts(tenant_id, id);
-- offline / double-click safety: one invoice per (shift, client-generated id)
CREATE UNIQUE INDEX uq_sales_invoices_pos_client ON sales_invoices (pos_shift_id, pos_client_id) WHERE pos_shift_id IS NOT NULL;
CREATE INDEX ix_sales_invoices_pos_shift ON sales_invoices (pos_shift_id) WHERE pos_shift_id IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pos_registers','pos_shifts','pos_payments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY p_tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO golden_app', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE pos_payments_id_seq TO golden_app;
REVOKE UPDATE, DELETE ON pos_payments FROM golden_app;

INSERT INTO permissions (code, module_code, name_ar, name_en, is_sensitive) VALUES
  ('pos.registers.manage',     'pos', 'إعداد نقاط البيع (المخزن، الحسابات، حد الخصم)', 'Configure registers (warehouse, accounts, discount limit)', true),
  ('pos.shifts.operate',       'pos', 'فتح وإغلاق ورديتي والبيع', 'Open/close my shift and sell', false),
  ('pos.shifts.supervise',     'pos', 'متابعة كل الورديات وإغلاقها وسحب النقدية', 'See and close any shift, cash drops', true),
  ('pos.sales.credit',         'pos', 'البيع الآجل في نقطة البيع', 'Sell on account at the POS', true),
  ('pos.sales.discount_override', 'pos', 'خصم يتجاوز حد نقطة البيع', 'Discount above the register limit', true),
  ('pos.sales.return',         'pos', 'المرتجعات في نقطة البيع', 'POS returns & refunds', true),
  ('pos.reports.view',         'pos', 'تقارير نقاط البيع', 'POS reports', false);
