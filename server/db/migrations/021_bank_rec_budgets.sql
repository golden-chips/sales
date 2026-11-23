-- =====================================================================
-- GOLDEN ERP — Migration 021: bank reconciliation and budgets (K5). Additive.
--   Bank reconciliation: a bank statement (opening, closing, lines) for one
--   bank/cash account; each statement line is matched to exactly one ledger
--   line of that account (a ledger line can be matched only once). Bank-only
--   items (fees, interest) become draft journal entries posted by someone
--   else, then matched.
--   Budgets: amounts per account (optionally cost centre) per month of a
--   fiscal year; approved budgets are compared with actuals.
-- =====================================================================

-- composite key so other tables can reference a ledger line inside the same tenant
ALTER TABLE journal_lines ADD CONSTRAINT uq_journal_lines_tenant_id UNIQUE (tenant_id, id);

CREATE TYPE bank_statement_status AS ENUM ('open', 'reconciled');

CREATE TABLE bank_statements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  company_id      uuid NOT NULL,
  account_id      uuid NOT NULL,
  statement_date  date NOT NULL,
  reference       text,
  opening_balance numeric(20,4) NOT NULL,
  closing_balance numeric(20,4) NOT NULL,
  status          bank_statement_status NOT NULL DEFAULT 'open',
  created_by      uuid NOT NULL,
  reconciled_by   uuid,
  reconciled_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (account_id, statement_date),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts(tenant_id, id)
);

CREATE TABLE bank_statement_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  statement_id     uuid NOT NULL,
  line_no          int NOT NULL,
  txn_date         date NOT NULL,
  description      text NOT NULL,
  reference        text,
  amount           numeric(20,4) NOT NULL CHECK (amount <> 0),     -- + money in, − money out (as on the bank statement)
  journal_line_id  uuid,                                          -- the ledger line it is matched to
  draft_entry_id   uuid,                                          -- adjusting entry created for a bank-only item, waiting to be posted
  matched_by       uuid,
  matched_at       timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (statement_id, line_no),
  FOREIGN KEY (tenant_id, statement_id) REFERENCES bank_statements(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, journal_line_id) REFERENCES journal_lines(tenant_id, id),
  FOREIGN KEY (tenant_id, draft_entry_id) REFERENCES journal_entries(tenant_id, id)
);
CREATE UNIQUE INDEX uq_bank_line_journal ON bank_statement_lines (journal_line_id) WHERE journal_line_id IS NOT NULL;

CREATE TYPE budget_status AS ENUM ('draft', 'approved');

CREATE TABLE budgets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  company_id     uuid NOT NULL,
  fiscal_year_id uuid NOT NULL,
  name           text NOT NULL CHECK (length(name) >= 2),
  status         budget_status NOT NULL DEFAULT 'draft',
  created_by     uuid NOT NULL,
  approved_by    uuid,
  approved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (fiscal_year_id, name),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, fiscal_year_id) REFERENCES fiscal_years(tenant_id, id)
);

CREATE TABLE budget_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  budget_id      uuid NOT NULL,
  account_id     uuid NOT NULL,
  cost_center_id uuid,
  period_no      smallint NOT NULL CHECK (period_no BETWEEN 1 AND 12),
  amount         numeric(20,4) NOT NULL CHECK (amount >= 0),     -- in the account's natural direction (revenue as income, expense as cost)
  FOREIGN KEY (tenant_id, budget_id) REFERENCES budgets(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, cost_center_id) REFERENCES cost_centers(tenant_id, id)
);
CREATE UNIQUE INDEX uq_budget_line ON budget_lines (budget_id, account_id, coalesce(cost_center_id, '00000000-0000-0000-0000-000000000000'::uuid), period_no);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bank_statements', 'bank_statement_lines', 'budgets', 'budget_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY p_tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO golden_app', t);
  END LOOP;
END $$;

INSERT INTO permissions (code, module_code, name_ar, name_en, is_sensitive) VALUES
  ('accounting.bank.reconcile',   'accounting', 'التسويات البنكية', 'Bank reconciliation', true),
  ('accounting.budgets.manage',   'accounting', 'إعداد الموازنات التقديرية', 'Prepare budgets', false),
  ('accounting.budgets.approve',  'accounting', 'اعتماد الموازنات التقديرية', 'Approve budgets', true);
