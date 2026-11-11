-- =====================================================================
-- GOLDEN ERP — Migration 005: Core ERP (Phase 2b)
-- Parties (customers/suppliers), items with UoM conversions, lots
-- (production/expiry), perpetual inventory with weighted-average cost,
-- sales invoices, customer returns (to quarantine), purchase receipts,
-- supplier invoices, payments, stock adjustments and quarantine release.
--
-- Rules enforced in the database:
--   * stock can never go negative (CHECK on balances)
--   * the stock ledger (stock_moves) is append-only
--   * posted documents are immutable (status guard trigger)
--   * a document number is unique per company and assigned at posting
-- =====================================================================

CREATE TYPE party_kind AS ENUM ('customer', 'supplier', 'both');
CREATE TYPE item_kind AS ENUM ('raw', 'packaging', 'semi_finished', 'finished', 'service');
CREATE TYPE doc_status AS ENUM ('draft', 'posted', 'cancelled');

CREATE TABLE parties (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  company_id         uuid NOT NULL,
  kind               party_kind NOT NULL,
  code               text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{1,30}$'),
  name_ar            text NOT NULL,
  name_en            text,
  phone              text,
  city               text,
  tax_number         text,
  credit_limit       numeric(20,3) CHECK (credit_limit >= 0),  -- NULL = no limit
  payment_terms_days int NOT NULL DEFAULT 0 CHECK (payment_terms_days BETWEEN 0 AND 365),
  is_active          boolean NOT NULL DEFAULT true,
  is_demo            boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, code),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id)
);
CREATE INDEX ix_parties_name ON parties(company_id, name_ar);
CREATE TRIGGER trg_parties_upd BEFORE UPDATE ON parties FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE uoms (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code      text NOT NULL CHECK (code ~ '^[A-Z0-9_]{1,12}$'),
  name_ar   text NOT NULL,
  name_en   text,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  company_id      uuid NOT NULL,
  code            text NOT NULL CHECK (code ~ '^[A-Z0-9_.-]{1,30}$'),
  name_ar         text NOT NULL,
  name_en         text,
  kind            item_kind NOT NULL,
  base_uom_id     uuid NOT NULL,
  barcode         text,
  track_lots      boolean NOT NULL DEFAULT false,
  shelf_life_days int CHECK (shelf_life_days > 0),
  sales_price     numeric(20,4) CHECK (sales_price >= 0),
  reorder_level   numeric(20,4) CHECK (reorder_level >= 0),
  is_active       boolean NOT NULL DEFAULT true,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, code),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, base_uom_id) REFERENCES uoms(tenant_id, id)
);
CREATE UNIQUE INDEX uq_items_barcode ON items(company_id, barcode) WHERE barcode IS NOT NULL;
CREATE TRIGGER trg_items_upd BEFORE UPDATE ON items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- alternative units: 1 <uom> = factor × base unit (e.g. 1 CARTON = 24 BAG)
CREATE TABLE item_uoms (
  tenant_id uuid NOT NULL,
  item_id   uuid NOT NULL,
  uom_id    uuid NOT NULL,
  factor    numeric(20,6) NOT NULL CHECK (factor > 0),
  barcode   text,
  PRIMARY KEY (item_id, uom_id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, uom_id) REFERENCES uoms(tenant_id, id)
);

CREATE TABLE customer_prices (
  tenant_id  uuid NOT NULL,
  party_id   uuid NOT NULL,
  item_id    uuid NOT NULL,
  price      numeric(20,4) NOT NULL CHECK (price >= 0),
  PRIMARY KEY (party_id, item_id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE lots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  item_id         uuid NOT NULL,
  lot_no          text NOT NULL CHECK (length(lot_no) BETWEEN 1 AND 60),
  production_date date,
  expiry_date     date,
  supplier_id     uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (item_id, lot_no),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES parties(tenant_id, id),
  CHECK (expiry_date IS NULL OR production_date IS NULL OR expiry_date >= production_date)
);

-- ---------------------------------------------------------------------
-- Perpetual inventory
-- ---------------------------------------------------------------------
-- cost layer per (warehouse, item): weighted average = value / qty
CREATE TABLE stock_balances (
  tenant_id    uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  item_id      uuid NOT NULL,
  qty          numeric(20,4) NOT NULL DEFAULT 0 CHECK (qty >= 0),
  value        numeric(20,4) NOT NULL DEFAULT 0 CHECK (value >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (warehouse_id, item_id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id),
  CHECK (qty > 0 OR value = 0)
);

-- quantity per lot (lots share the warehouse/item average cost)
CREATE TABLE lot_balances (
  tenant_id    uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  lot_id       uuid NOT NULL,
  qty          numeric(20,4) NOT NULL DEFAULT 0 CHECK (qty >= 0),
  PRIMARY KEY (warehouse_id, lot_id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, lot_id) REFERENCES lots(tenant_id, id)
);

CREATE TABLE stock_moves (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  company_id   uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  item_id      uuid NOT NULL,
  lot_id       uuid,
  move_date    date NOT NULL,
  qty          numeric(20,4) NOT NULL CHECK (qty <> 0),      -- signed, base unit
  unit_cost    numeric(20,6) NOT NULL CHECK (unit_cost >= 0),
  value        numeric(20,4) NOT NULL,                       -- signed
  source_type  text NOT NULL,
  source_id    uuid NOT NULL,
  source_line_id uuid,                                       -- exact document line (traceability)
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id),
  FOREIGN KEY (tenant_id, lot_id) REFERENCES lots(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  CHECK (sign(qty) = sign(value) OR value = 0)
);
CREATE INDEX ix_stock_moves_item ON stock_moves(item_id, move_date);
CREATE INDEX ix_stock_moves_lot ON stock_moves(lot_id) WHERE lot_id IS NOT NULL;
CREATE INDEX ix_stock_moves_source ON stock_moves(source_type, source_id);
CREATE TRIGGER trg_stock_moves_append_only BEFORE UPDATE OR DELETE ON stock_moves FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------
-- Documents (common columns: number assigned at posting, status guard)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION doc_status_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION '% is % and cannot be deleted', TG_TABLE_NAME, OLD.status USING ERRCODE = 'P0001'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'posted' THEN
    -- only running totals maintained by later documents may change
    IF (to_jsonb(NEW) - ARRAY['amount_paid','amount_returned','amount_invoiced','updated_at'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['amount_paid','amount_returned','amount_invoiced','updated_at']) THEN
      RAISE EXCEPTION 'posted % is immutable', TG_TABLE_NAME USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION doc_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE s doc_status; parent text := TG_ARGV[0];
BEGIN
  EXECUTE format('SELECT status FROM %I WHERE id = $1', parent) INTO s USING coalesce(NEW.doc_id, OLD.doc_id);
  IF s IS NOT NULL AND s <> 'draft' THEN
    RAISE EXCEPTION 'lines of a % document are immutable', s USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE TYPE payment_type AS ENUM ('cash', 'credit');

CREATE TABLE sales_invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  company_id      uuid NOT NULL,
  branch_id       uuid,
  warehouse_id    uuid NOT NULL,
  customer_id     uuid NOT NULL,
  number          text,
  invoice_date    date NOT NULL,
  due_date        date,
  payment_type    payment_type NOT NULL,
  status          doc_status NOT NULL DEFAULT 'draft',
  currency        char(3) NOT NULL REFERENCES currencies(code),
  subtotal        numeric(20,4) NOT NULL DEFAULT 0,
  discount_total  numeric(20,4) NOT NULL DEFAULT 0,
  tax_total       numeric(20,4) NOT NULL DEFAULT 0,
  total           numeric(20,4) NOT NULL DEFAULT 0 CHECK (total >= 0),
  cogs_total      numeric(20,4) NOT NULL DEFAULT 0,
  amount_paid     numeric(20,4) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  amount_returned numeric(20,4) NOT NULL DEFAULT 0 CHECK (amount_returned >= 0),
  notes           text,
  journal_entry_id uuid,
  is_demo         boolean NOT NULL DEFAULT false,
  created_by      uuid NOT NULL,
  posted_by       uuid,
  posted_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, number),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES parties(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, posted_by) REFERENCES users(tenant_id, id),
  CHECK (amount_paid + amount_returned <= total),
  CHECK (status = 'draft' OR (number IS NOT NULL AND posted_by IS NOT NULL))
);
CREATE INDEX ix_sales_invoices_customer ON sales_invoices(customer_id, invoice_date);

CREATE TABLE sales_invoice_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  doc_id       uuid NOT NULL,
  line_no      smallint NOT NULL,
  item_id      uuid NOT NULL,
  uom_id       uuid NOT NULL,
  factor       numeric(20,6) NOT NULL CHECK (factor > 0),
  qty          numeric(20,4) NOT NULL CHECK (qty > 0),
  base_qty     numeric(20,4) NOT NULL CHECK (base_qty > 0),
  unit_price   numeric(20,4) NOT NULL CHECK (unit_price >= 0),
  discount_pct numeric(7,4) NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
  tax_pct      numeric(7,4) NOT NULL DEFAULT 0 CHECK (tax_pct BETWEEN 0 AND 100),
  net_amount   numeric(20,4) NOT NULL,
  tax_amount   numeric(20,4) NOT NULL,
  line_total   numeric(20,4) NOT NULL,
  lot_id       uuid,
  cost_amount  numeric(20,4),
  UNIQUE (doc_id, line_no),
  FOREIGN KEY (tenant_id, doc_id) REFERENCES sales_invoices(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id),
  FOREIGN KEY (tenant_id, uom_id) REFERENCES uoms(tenant_id, id),
  FOREIGN KEY (tenant_id, lot_id) REFERENCES lots(tenant_id, id)
);

CREATE TABLE sales_returns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  company_id      uuid NOT NULL,
  invoice_id      uuid NOT NULL,
  warehouse_id    uuid NOT NULL,                -- MUST be a quarantine warehouse
  number          text,
  return_date     date NOT NULL,
  reason          text NOT NULL,
  status          doc_status NOT NULL DEFAULT 'draft',
  total           numeric(20,4) NOT NULL DEFAULT 0,
  cost_total      numeric(20,4) NOT NULL DEFAULT 0,
  journal_entry_id uuid,
  created_by      uuid NOT NULL,
  posted_by       uuid,
  posted_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, number),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES sales_invoices(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, posted_by) REFERENCES users(tenant_id, id)
);

CREATE TABLE sales_return_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  doc_id          uuid NOT NULL,
  line_no         smallint NOT NULL,
  invoice_line_id uuid NOT NULL,
  base_qty        numeric(20,4) NOT NULL CHECK (base_qty > 0),
  amount          numeric(20,4) NOT NULL CHECK (amount >= 0),
  cost_amount     numeric(20,4),
  UNIQUE (doc_id, line_no),
  FOREIGN KEY (tenant_id, doc_id) REFERENCES sales_returns(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE purchase_receipts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  company_id      uuid NOT NULL,
  supplier_id     uuid NOT NULL,
  warehouse_id    uuid NOT NULL,
  number          text,
  receipt_date    date NOT NULL,
  supplier_ref    text,
  status          doc_status NOT NULL DEFAULT 'draft',
  total           numeric(20,4) NOT NULL DEFAULT 0,
  amount_invoiced numeric(20,4) NOT NULL DEFAULT 0 CHECK (amount_invoiced >= 0),
  journal_entry_id uuid,
  created_by      uuid NOT NULL,
  posted_by       uuid,
  posted_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, number),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES parties(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, posted_by) REFERENCES users(tenant_id, id),
  CHECK (amount_invoiced <= total)
);

CREATE TABLE purchase_receipt_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  doc_id          uuid NOT NULL,
  line_no         smallint NOT NULL,
  item_id         uuid NOT NULL,
  uom_id          uuid NOT NULL,
  factor          numeric(20,6) NOT NULL CHECK (factor > 0),
  qty             numeric(20,4) NOT NULL CHECK (qty > 0),
  base_qty        numeric(20,4) NOT NULL CHECK (base_qty > 0),
  unit_cost       numeric(20,4) NOT NULL CHECK (unit_cost >= 0),   -- per chosen uom
  line_total      numeric(20,4) NOT NULL,
  lot_no          text,
  production_date date,
  expiry_date     date,
  lot_id          uuid,
  UNIQUE (doc_id, line_no),
  FOREIGN KEY (tenant_id, doc_id) REFERENCES purchase_receipts(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id),
  FOREIGN KEY (tenant_id, uom_id) REFERENCES uoms(tenant_id, id),
  FOREIGN KEY (tenant_id, lot_id) REFERENCES lots(tenant_id, id)
);

CREATE TABLE supplier_invoices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  company_id       uuid NOT NULL,
  supplier_id      uuid NOT NULL,
  receipt_id       uuid NOT NULL,
  number           text,
  supplier_invoice_no text NOT NULL,
  invoice_date     date NOT NULL,
  due_date         date,
  status           doc_status NOT NULL DEFAULT 'draft',
  total            numeric(20,4) NOT NULL CHECK (total > 0),
  amount_paid      numeric(20,4) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  journal_entry_id uuid,
  created_by       uuid NOT NULL,
  posted_by        uuid,
  posted_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, number),
  UNIQUE (supplier_id, supplier_invoice_no),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES parties(tenant_id, id),
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES purchase_receipts(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, posted_by) REFERENCES users(tenant_id, id),
  CHECK (amount_paid <= total)
);

CREATE TYPE payment_direction AS ENUM ('in', 'out');
CREATE TYPE payment_method AS ENUM ('cash', 'bank', 'rep_custody');

CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  company_id          uuid NOT NULL,
  direction           payment_direction NOT NULL,
  party_id            uuid NOT NULL,
  method              payment_method NOT NULL,
  number              text,
  payment_date        date NOT NULL,
  amount              numeric(20,4) NOT NULL CHECK (amount > 0),
  reference           text,
  sales_invoice_id    uuid,
  supplier_invoice_id uuid,
  status              doc_status NOT NULL DEFAULT 'draft',
  journal_entry_id    uuid,
  created_by          uuid NOT NULL,
  posted_by           uuid,
  posted_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, number),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id),
  FOREIGN KEY (tenant_id, sales_invoice_id) REFERENCES sales_invoices(tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_invoice_id) REFERENCES supplier_invoices(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, posted_by) REFERENCES users(tenant_id, id),
  CHECK (direction = 'in' OR sales_invoice_id IS NULL),
  CHECK (direction = 'out' OR supplier_invoice_id IS NULL)
);

-- how a receipt/payment settled specific invoices (FIFO when not specified)
CREATE TABLE payment_allocations (
  tenant_id           uuid NOT NULL,
  payment_id          uuid NOT NULL,
  sales_invoice_id    uuid,
  supplier_invoice_id uuid,
  amount              numeric(20,4) NOT NULL CHECK (amount > 0),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES payments(tenant_id, id),
  FOREIGN KEY (tenant_id, sales_invoice_id) REFERENCES sales_invoices(tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_invoice_id) REFERENCES supplier_invoices(tenant_id, id),
  CHECK ((sales_invoice_id IS NULL) <> (supplier_invoice_id IS NULL))
);
CREATE INDEX ix_payment_alloc_payment ON payment_allocations(payment_id);
CREATE TRIGGER trg_payment_alloc_append_only BEFORE UPDATE OR DELETE ON payment_allocations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TYPE adjustment_reason AS ENUM ('opening', 'count', 'damage', 'quarantine_release', 'transfer');

-- stock adjustments, count corrections, transfers and quarantine release
CREATE TABLE stock_documents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  company_id         uuid NOT NULL,
  reason             adjustment_reason NOT NULL,
  warehouse_id       uuid NOT NULL,
  to_warehouse_id    uuid,                 -- transfer / quarantine_release
  number             text,
  doc_date           date NOT NULL,
  notes              text,
  status             doc_status NOT NULL DEFAULT 'draft',
  journal_entry_id   uuid,
  created_by         uuid NOT NULL,
  posted_by          uuid,
  posted_at          timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, number),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, to_warehouse_id) REFERENCES warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, posted_by) REFERENCES users(tenant_id, id),
  CHECK ((reason IN ('transfer','quarantine_release')) = (to_warehouse_id IS NOT NULL)),
  CHECK (to_warehouse_id IS NULL OR to_warehouse_id <> warehouse_id)
);

CREATE TABLE stock_document_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  doc_id      uuid NOT NULL,
  line_no     smallint NOT NULL,
  item_id     uuid NOT NULL,
  qty_delta   numeric(20,4) NOT NULL CHECK (qty_delta <> 0), -- base unit; transfers use positive qty
  unit_cost   numeric(20,4) CHECK (unit_cost >= 0),          -- required for increases
  lot_no      text,
  production_date date,
  expiry_date date,
  lot_id      uuid,
  UNIQUE (doc_id, line_no),
  FOREIGN KEY (tenant_id, doc_id) REFERENCES stock_documents(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id),
  FOREIGN KEY (tenant_id, lot_id) REFERENCES lots(tenant_id, id)
);

-- guards
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sales_invoices','sales_returns','purchase_receipts','supplier_invoices','payments','stock_documents'] LOOP
    EXECUTE format('CREATE TRIGGER trg_%s_status_guard BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION doc_status_guard()', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_upd BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;
CREATE TRIGGER trg_sil_guard BEFORE INSERT OR UPDATE OR DELETE ON sales_invoice_lines FOR EACH ROW EXECUTE FUNCTION doc_lines_guard('sales_invoices');
CREATE TRIGGER trg_srl_guard BEFORE INSERT OR UPDATE OR DELETE ON sales_return_lines FOR EACH ROW EXECUTE FUNCTION doc_lines_guard('sales_returns');
CREATE TRIGGER trg_prl_guard BEFORE INSERT OR UPDATE OR DELETE ON purchase_receipt_lines FOR EACH ROW EXECUTE FUNCTION doc_lines_guard('purchase_receipts');
-- stock document lines get lot_id assigned during posting, so they are guarded in the service layer + status of the header

-- RLS
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['parties','uoms','items','item_uoms','customer_prices','lots','stock_balances','lot_balances','stock_moves',
    'sales_invoices','sales_invoice_lines','sales_returns','sales_return_lines','purchase_receipts','purchase_receipt_lines',
    'supplier_invoices','payments','payment_allocations','stock_documents','stock_document_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY p_tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO golden_app', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE stock_moves_id_seq TO golden_app;
REVOKE UPDATE, DELETE ON stock_moves FROM golden_app;
GRANT EXECUTE ON FUNCTION doc_status_guard(), doc_lines_guard() TO golden_app;

-- permissions
INSERT INTO permissions (code, module_code, name_ar, name_en, is_sensitive) VALUES
  ('inventory.items.view',         'inventory', 'عرض الأصناف', 'View items', false),
  ('inventory.items.manage',       'inventory', 'إدارة الأصناف ووحدات القياس', 'Manage items & units', false),
  ('inventory.stock.view',         'inventory', 'عرض الأرصدة وحركة المخزون', 'View stock & movements', false),
  ('inventory.moves.create',       'inventory', 'إنشاء تسويات وتحويلات مخزنية', 'Create stock adjustments & transfers', false),
  ('inventory.moves.post',         'inventory', 'ترحيل المستندات المخزنية', 'Post stock documents', true),
  ('inventory.quarantine.release', 'inventory', 'الإفراج عن بضاعة الحجر بعد الفحص', 'Release quarantined stock', true),
  ('sales.customers.view',         'sales', 'عرض العملاء', 'View customers', false),
  ('sales.customers.manage',       'sales', 'إدارة العملاء والأسعار الخاصة وحدود الائتمان', 'Manage customers, prices & credit limits', true),
  ('sales.invoices.view',          'sales', 'عرض فواتير المبيعات', 'View sales invoices', false),
  ('sales.invoices.create',        'sales', 'إنشاء فواتير المبيعات', 'Create sales invoices', false),
  ('sales.invoices.post',          'sales', 'ترحيل فواتير المبيعات', 'Post sales invoices', true),
  ('sales.returns.create',         'sales', 'إنشاء مرتجعات المبيعات', 'Create sales returns', false),
  ('sales.returns.post',           'sales', 'ترحيل مرتجعات المبيعات', 'Post sales returns', true),
  ('sales.receipts.create',        'sales', 'إنشاء سندات القبض', 'Create customer receipts', false),
  ('sales.receipts.post',          'sales', 'ترحيل سندات القبض', 'Post customer receipts', true),
  ('sales.reports.view',           'sales', 'تقارير المبيعات وأعمار الديون', 'Sales & AR aging reports', false),
  ('purchasing.suppliers.view',    'purchasing', 'عرض الموردين', 'View suppliers', false),
  ('purchasing.suppliers.manage',  'purchasing', 'إدارة الموردين', 'Manage suppliers', false),
  ('purchasing.receipts.view',     'purchasing', 'عرض أذونات الاستلام وفواتير الموردين', 'View receipts & supplier invoices', false),
  ('purchasing.receipts.create',   'purchasing', 'إنشاء أذونات الاستلام', 'Create goods receipts', false),
  ('purchasing.receipts.post',     'purchasing', 'ترحيل أذونات الاستلام', 'Post goods receipts', true),
  ('purchasing.invoices.create',   'purchasing', 'إنشاء فواتير الموردين', 'Create supplier invoices', false),
  ('purchasing.invoices.post',     'purchasing', 'ترحيل فواتير الموردين', 'Post supplier invoices', true),
  ('purchasing.payments.create',   'purchasing', 'إنشاء سندات الصرف للموردين', 'Create supplier payments', false),
  ('purchasing.payments.post',     'purchasing', 'ترحيل سندات الصرف', 'Post supplier payments', true);
