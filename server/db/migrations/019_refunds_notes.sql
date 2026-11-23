-- =====================================================================
-- GOLDEN ERP — Migration 019: refunds on returns, customer credit notes,
-- supplier debit notes (K15). Additive only.
--   * A return of an invoice that was already paid refunds the excess in
--     cash or by bank (chosen on the draft); the refund is recorded on the
--     return so the customer statement shows it.
--   * Customer credit note: a discount / allowance after the sale on one
--     posted invoice (no goods back): Dr chosen account (default sales
--     discounts) / Cr receivables; reduces the invoice's open balance.
--   * Supplier debit note: a discount / settlement from the supplier on one
--     posted supplier invoice: Dr payables / Cr chosen account; reduces the
--     supplier invoice's open balance.
--   Charging a customer more is an ordinary invoice with a service item.
-- =====================================================================

ALTER TABLE sales_returns
  ADD COLUMN refund_method text CHECK (refund_method IN ('cash', 'bank')),
  ADD COLUMN refund_amount numeric(20,4) CHECK (refund_amount >= 0),
  ADD COLUMN refund_account_id uuid,
  ADD FOREIGN KEY (tenant_id, refund_account_id) REFERENCES accounts(tenant_id, id);

CREATE TYPE adjustment_note_kind AS ENUM ('customer_credit', 'supplier_debit');

CREATE TABLE adjustment_notes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  company_id          uuid NOT NULL,
  kind                adjustment_note_kind NOT NULL,
  number              text,
  status              doc_status NOT NULL DEFAULT 'draft',
  note_date           date NOT NULL,
  party_id            uuid NOT NULL,
  sales_invoice_id    uuid,
  supplier_invoice_id uuid,
  amount              numeric(20,4) NOT NULL CHECK (amount > 0),
  account_id          uuid NOT NULL,          -- the other side: discount / allowance / income / stock adjustment
  reason              text NOT NULL CHECK (length(reason) >= 3),
  total               numeric(20,4) GENERATED ALWAYS AS (amount) STORED,
  journal_entry_id    uuid,
  created_by          uuid NOT NULL,
  posted_by           uuid,
  posted_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, number),
  CHECK ((kind = 'customer_credit') = (sales_invoice_id IS NOT NULL) AND (kind = 'supplier_debit') = (supplier_invoice_id IS NOT NULL)),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id),
  FOREIGN KEY (tenant_id, sales_invoice_id) REFERENCES sales_invoices(tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_invoice_id) REFERENCES supplier_invoices(tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries(tenant_id, id)
);
CREATE INDEX ix_adjustment_notes_party ON adjustment_notes (party_id);
CREATE TRIGGER trg_adjustment_notes_guard BEFORE UPDATE OR DELETE ON adjustment_notes FOR EACH ROW EXECUTE FUNCTION doc_status_guard();
CREATE TRIGGER trg_adjustment_notes_upd BEFORE UPDATE ON adjustment_notes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE adjustment_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE adjustment_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY p_tenant_isolation ON adjustment_notes USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON adjustment_notes TO golden_app;

INSERT INTO permissions (code, module_code, name_ar, name_en, is_sensitive) VALUES
  ('sales.notes.create',      'sales',      'إنشاء إشعارات دائنة للعملاء (خصم بعد البيع)', 'Create customer credit notes', false),
  ('sales.notes.post',        'sales',      'ترحيل الإشعارات الدائنة للعملاء', 'Post customer credit notes', true),
  ('purchasing.notes.create', 'purchasing', 'إنشاء إشعارات مدينة للموردين', 'Create supplier debit notes', false),
  ('purchasing.notes.post',   'purchasing', 'ترحيل الإشعارات المدينة للموردين', 'Post supplier debit notes', true);
