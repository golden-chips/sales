-- =====================================================================
-- GOLDEN ERP — Migration 016: quotations, sales orders, purchase orders
--   quotation → sales order (credit check + stock reservation) → invoices
--   purchase order (approval above a threshold) → goods receipts
-- Orders carry no money in the GL: invoices and receipts post, as before;
-- each invoice / receipt line can point to the order line it fulfils.
-- =====================================================================

CREATE TABLE order_settings (
  tenant_id              uuid NOT NULL,
  company_id             uuid PRIMARY KEY,
  po_approval_threshold  numeric(20,4) NOT NULL DEFAULT 0 CHECK (po_approval_threshold >= 0),  -- POs above it need an approver ≠ creator
  quotation_valid_days   smallint NOT NULL DEFAULT 15 CHECK (quotation_valid_days BETWEEN 1 AND 365),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id)
);

-- ------------------------------------------------------------------ sales quotations
CREATE TYPE quotation_status AS ENUM ('draft', 'sent', 'accepted', 'rejected', 'converted');
CREATE TABLE sales_quotations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  company_id     uuid NOT NULL,
  branch_id      uuid,
  customer_id    uuid NOT NULL,
  number         text NOT NULL,
  quote_date     date NOT NULL,
  valid_until    date NOT NULL,
  status         quotation_status NOT NULL DEFAULT 'draft',
  subtotal       numeric(20,4) NOT NULL DEFAULT 0,
  discount_total numeric(20,4) NOT NULL DEFAULT 0,
  total          numeric(20,4) NOT NULL DEFAULT 0,
  notes          text,
  reject_reason  text,
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, number),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES parties(tenant_id, id),
  CHECK (valid_until >= quote_date)
);
CREATE TABLE sales_quotation_lines (
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
  line_total   numeric(20,4) NOT NULL,
  UNIQUE (doc_id, line_no),
  FOREIGN KEY (tenant_id, doc_id) REFERENCES sales_quotations(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id),
  FOREIGN KEY (tenant_id, uom_id) REFERENCES uoms(tenant_id, id)
);

-- ------------------------------------------------------------------ sales orders
CREATE TYPE sales_order_status AS ENUM ('draft', 'confirmed', 'partially_delivered', 'delivered', 'closed', 'cancelled');
CREATE TABLE sales_orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  company_id     uuid NOT NULL,
  branch_id      uuid,
  warehouse_id   uuid NOT NULL,
  customer_id    uuid NOT NULL,
  quotation_id   uuid,
  number         text NOT NULL,
  order_date     date NOT NULL,
  delivery_date  date,
  payment_type   payment_type NOT NULL DEFAULT 'credit',
  status         sales_order_status NOT NULL DEFAULT 'draft',
  subtotal       numeric(20,4) NOT NULL DEFAULT 0,
  discount_total numeric(20,4) NOT NULL DEFAULT 0,
  total          numeric(20,4) NOT NULL DEFAULT 0,
  notes          text,
  close_reason   text,
  created_by     uuid NOT NULL,
  confirmed_by   uuid,
  confirmed_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, number),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES parties(tenant_id, id),
  FOREIGN KEY (tenant_id, quotation_id) REFERENCES sales_quotations(tenant_id, id)
);
CREATE TABLE sales_order_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  doc_id             uuid NOT NULL,
  line_no            smallint NOT NULL,
  item_id            uuid NOT NULL,
  uom_id             uuid NOT NULL,
  factor             numeric(20,6) NOT NULL CHECK (factor > 0),
  qty                numeric(20,4) NOT NULL CHECK (qty > 0),
  base_qty           numeric(20,4) NOT NULL CHECK (base_qty > 0),
  unit_price         numeric(20,4) NOT NULL CHECK (unit_price >= 0),
  discount_pct       numeric(7,4) NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
  line_total         numeric(20,4) NOT NULL,
  delivered_base_qty numeric(20,4) NOT NULL DEFAULT 0 CHECK (delivered_base_qty >= 0),
  UNIQUE (tenant_id, id),
  UNIQUE (doc_id, line_no),
  FOREIGN KEY (tenant_id, doc_id) REFERENCES sales_orders(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id),
  FOREIGN KEY (tenant_id, uom_id) REFERENCES uoms(tenant_id, id),
  CHECK (delivered_base_qty <= base_qty)         -- never deliver more than ordered
);
CREATE INDEX ix_sales_orders_open ON sales_orders (company_id, status) WHERE status IN ('confirmed', 'partially_delivered');

ALTER TABLE sales_invoices ADD COLUMN sales_order_id uuid, ADD FOREIGN KEY (tenant_id, sales_order_id) REFERENCES sales_orders(tenant_id, id);
ALTER TABLE sales_invoice_lines ADD COLUMN order_line_id uuid, ADD FOREIGN KEY (tenant_id, order_line_id) REFERENCES sales_order_lines(tenant_id, id);

-- ------------------------------------------------------------------ purchase orders
CREATE TYPE purchase_order_status AS ENUM ('draft', 'pending_approval', 'approved', 'partially_received', 'received', 'rejected', 'closed', 'cancelled');
CREATE TABLE purchase_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  company_id      uuid NOT NULL,
  supplier_id     uuid NOT NULL,
  warehouse_id    uuid NOT NULL,
  number          text NOT NULL,
  order_date      date NOT NULL,
  expected_date   date,
  status          purchase_order_status NOT NULL DEFAULT 'draft',
  total           numeric(20,4) NOT NULL DEFAULT 0,
  notes           text,
  decision_reason text,
  created_by      uuid NOT NULL,
  approved_by     uuid,
  approved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, number),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES parties(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id)
);
CREATE TABLE purchase_order_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  doc_id            uuid NOT NULL,
  line_no           smallint NOT NULL,
  item_id           uuid NOT NULL,
  uom_id            uuid NOT NULL,
  factor            numeric(20,6) NOT NULL CHECK (factor > 0),
  qty               numeric(20,4) NOT NULL CHECK (qty > 0),
  base_qty          numeric(20,4) NOT NULL CHECK (base_qty > 0),
  unit_cost         numeric(20,4) NOT NULL CHECK (unit_cost >= 0),       -- per chosen uom
  line_total        numeric(20,4) NOT NULL,
  received_base_qty numeric(20,4) NOT NULL DEFAULT 0 CHECK (received_base_qty >= 0),
  UNIQUE (tenant_id, id),
  UNIQUE (doc_id, line_no),
  FOREIGN KEY (tenant_id, doc_id) REFERENCES purchase_orders(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id),
  FOREIGN KEY (tenant_id, uom_id) REFERENCES uoms(tenant_id, id),
  CHECK (received_base_qty <= base_qty)          -- no over-receipt against an order
);
CREATE INDEX ix_purchase_orders_open ON purchase_orders (company_id, status) WHERE status IN ('approved', 'partially_received');

ALTER TABLE purchase_receipts ADD COLUMN purchase_order_id uuid, ADD FOREIGN KEY (tenant_id, purchase_order_id) REFERENCES purchase_orders(tenant_id, id);
ALTER TABLE purchase_receipt_lines ADD COLUMN order_line_id uuid, ADD FOREIGN KEY (tenant_id, order_line_id) REFERENCES purchase_order_lines(tenant_id, id);

-- ------------------------------------------------------------------ guards: only drafts are edited; afterwards only fulfilment counters move
CREATE OR REPLACE FUNCTION trg_order_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text; parent text := TG_ARGV[0]; counter text := TG_ARGV[1];
BEGIN
  EXECUTE format('SELECT status::text FROM %I WHERE id = $1', parent) INTO st USING coalesce(NEW.doc_id, OLD.doc_id);
  IF st IS NULL OR st = 'draft' THEN RETURN coalesce(NEW, OLD); END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - counter) = (to_jsonb(OLD) - counter) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'lines of a % % are frozen', st, parent USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER sales_quotation_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON sales_quotation_lines FOR EACH ROW EXECUTE FUNCTION trg_order_lines_guard('sales_quotations', 'none');
CREATE TRIGGER sales_order_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON sales_order_lines FOR EACH ROW EXECUTE FUNCTION trg_order_lines_guard('sales_orders', 'delivered_base_qty');
CREATE TRIGGER purchase_order_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON purchase_order_lines FOR EACH ROW EXECUTE FUNCTION trg_order_lines_guard('purchase_orders', 'received_base_qty');

CREATE OR REPLACE FUNCTION trg_order_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status::text <> 'draft' THEN RAISE EXCEPTION '% is % and cannot be deleted (cancel or close it instead)', TG_TABLE_NAME, OLD.status USING ERRCODE = 'P0001'; END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER sales_quotations_del BEFORE DELETE ON sales_quotations FOR EACH ROW EXECUTE FUNCTION trg_order_delete_guard();
CREATE TRIGGER sales_orders_del BEFORE DELETE ON sales_orders FOR EACH ROW EXECUTE FUNCTION trg_order_delete_guard();
CREATE TRIGGER purchase_orders_del BEFORE DELETE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION trg_order_delete_guard();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['order_settings','sales_quotations','sales_quotation_lines','sales_orders','sales_order_lines','purchase_orders','purchase_order_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY p_tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO golden_app', t);
  END LOOP;
END $$;

INSERT INTO permissions (code, module_code, name_ar, name_en, is_sensitive) VALUES
  ('sales.quotations.manage', 'sales', 'عروض الأسعار', 'Sales quotations', false),
  ('sales.orders.manage',     'sales', 'أوامر البيع (إنشاء، تأكيد، فوترة)', 'Sales orders (create, confirm, invoice)', false),
  ('purchasing.orders.manage',  'purchasing', 'أوامر الشراء (إنشاء وإرسال للاعتماد واستلام)', 'Purchase orders (create, submit, receive)', false),
  ('purchasing.orders.approve', 'purchasing', 'اعتماد أوامر الشراء', 'Approve purchase orders', true),
  ('purchasing.settings.manage', 'purchasing', 'حد اعتماد أوامر الشراء', 'Purchase order approval threshold', true);
