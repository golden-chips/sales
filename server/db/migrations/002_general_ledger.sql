-- =====================================================================
-- GOLDEN ERP — Migration 002: General Ledger core (double entry)
-- Integrity rules enforced IN THE DATABASE (not only in services):
--   * a line is either a debit or a credit, never both, never zero
--   * a posted entry is balanced (deferred constraint trigger)
--   * a posted entry and its lines are immutable; correction = reversal
--   * posting only into an open fiscal period
--   * one source document can be posted only once (unique source key)
--   * accounts posted to must be active leaf (postable) accounts
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE account_type AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense');
CREATE TYPE balance_side AS ENUM ('debit', 'credit');

CREATE TABLE accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  company_id     uuid NOT NULL,
  code           text NOT NULL CHECK (code ~ '^[0-9]{1,12}$'),
  name_ar        text NOT NULL,
  name_en        text,
  type           account_type NOT NULL,
  normal_balance balance_side NOT NULL,
  parent_id      uuid,
  is_postable    boolean NOT NULL DEFAULT true,
  is_active      boolean NOT NULL DEFAULT true,
  currency       char(3) REFERENCES currencies(code),   -- NULL = any currency
  requires_cost_center boolean NOT NULL DEFAULT false,
  -- marks system-meaning accounts (e.g. 'ar', 'ap', 'inventory', 'retained_earnings')
  role           text,
  is_demo        boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, code),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES accounts(tenant_id, id),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE UNIQUE INDEX uq_accounts_role ON accounts(company_id, role) WHERE role IS NOT NULL;
CREATE INDEX ix_accounts_parent ON accounts(parent_id);
CREATE TRIGGER trg_accounts_upd BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE cost_centers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  company_id uuid NOT NULL,
  code       text NOT NULL,
  name_ar    text NOT NULL,
  name_en    text,
  parent_id  uuid,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, code),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES cost_centers(tenant_id, id)
);

CREATE TYPE period_status AS ENUM ('open', 'closed');

CREATE TABLE fiscal_years (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  company_id uuid NOT NULL,
  name       text NOT NULL,
  start_date date NOT NULL,
  end_date   date NOT NULL,
  status     period_status NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, name),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  CHECK (end_date > start_date)
);
-- fiscal years of one company may not overlap
ALTER TABLE fiscal_years ADD CONSTRAINT ex_fiscal_years_overlap
  EXCLUDE USING gist (company_id WITH =, daterange(start_date, end_date, '[]') WITH &&);

CREATE TABLE fiscal_periods (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  company_id     uuid NOT NULL,
  fiscal_year_id uuid NOT NULL,
  period_no      smallint NOT NULL CHECK (period_no BETWEEN 1 AND 13),
  start_date     date NOT NULL,
  end_date       date NOT NULL,
  status         period_status NOT NULL DEFAULT 'open',
  closed_at      timestamptz,
  closed_by      uuid,
  UNIQUE (tenant_id, id),
  UNIQUE (fiscal_year_id, period_no),
  FOREIGN KEY (tenant_id, fiscal_year_id) REFERENCES fiscal_years(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  CHECK (end_date >= start_date)
);
ALTER TABLE fiscal_periods ADD CONSTRAINT ex_fiscal_periods_overlap
  EXCLUDE USING gist (company_id WITH =, daterange(start_date, end_date, '[]') WITH &&);

CREATE TABLE exchange_rates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  from_currency char(3) NOT NULL REFERENCES currencies(code),
  to_currency   char(3) NOT NULL REFERENCES currencies(code),
  rate_date     date NOT NULL,
  rate          numeric(20,10) NOT NULL CHECK (rate > 0),
  source        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, from_currency, to_currency, rate_date),
  CHECK (from_currency <> to_currency)
);

CREATE TYPE journal_status AS ENUM ('draft', 'posted', 'reversed');

CREATE TABLE journal_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  company_id   uuid NOT NULL,
  branch_id    uuid,
  number       text,                       -- assigned at posting (gap-free)
  entry_date   date NOT NULL,
  period_id    uuid,                       -- resolved at posting
  status       journal_status NOT NULL DEFAULT 'draft',
  currency     char(3) NOT NULL REFERENCES currencies(code),
  memo         text NOT NULL,
  reference    text,
  -- origin of the entry; manual entries have source_type = 'manual'
  source_type  text NOT NULL DEFAULT 'manual',
  source_id    text,
  reversal_of  uuid,
  reversed_by  uuid,
  is_demo      boolean NOT NULL DEFAULT false,
  created_by   uuid NOT NULL,
  posted_by    uuid,
  posted_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, number),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  FOREIGN KEY (tenant_id, period_id) REFERENCES fiscal_periods(tenant_id, id),
  FOREIGN KEY (tenant_id, reversal_of) REFERENCES journal_entries(tenant_id, id),
  FOREIGN KEY (tenant_id, reversed_by) REFERENCES journal_entries(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, posted_by) REFERENCES users(tenant_id, id),
  CHECK ((status = 'draft') = (posted_at IS NULL)),
  CHECK (status = 'draft' OR (number IS NOT NULL AND period_id IS NOT NULL AND posted_by IS NOT NULL)),
  CHECK ((status = 'reversed') = (reversed_by IS NOT NULL))
);
-- a source document (invoice, payroll run, ...) can generate only ONE live entry
CREATE UNIQUE INDEX uq_journal_source ON journal_entries(company_id, source_type, source_id)
  WHERE source_id IS NOT NULL AND reversal_of IS NULL;
-- an entry can be reversed only once
CREATE UNIQUE INDEX uq_journal_reversal_of ON journal_entries(reversal_of) WHERE reversal_of IS NOT NULL;
CREATE INDEX ix_journal_company_date ON journal_entries(company_id, entry_date);
CREATE TRIGGER trg_journal_entries_upd BEFORE UPDATE ON journal_entries FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE journal_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  entry_id       uuid NOT NULL,
  line_no        smallint NOT NULL CHECK (line_no > 0),
  account_id     uuid NOT NULL,
  cost_center_id uuid,
  description    text,
  -- amounts in the company base currency
  debit          numeric(20,4) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit         numeric(20,4) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  -- original transaction currency amount and rate (base = fc * fx_rate)
  currency       char(3) NOT NULL REFERENCES currencies(code),
  fx_rate        numeric(20,10) NOT NULL DEFAULT 1 CHECK (fx_rate > 0),
  amount_fc      numeric(20,4) NOT NULL CHECK (amount_fc >= 0),
  UNIQUE (entry_id, line_no),
  FOREIGN KEY (tenant_id, entry_id) REFERENCES journal_entries(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, cost_center_id) REFERENCES cost_centers(tenant_id, id),
  CHECK ((debit = 0) <> (credit = 0))
);
CREATE INDEX ix_journal_lines_account ON journal_lines(account_id);
CREATE INDEX ix_journal_lines_entry ON journal_lines(entry_id);

-- ---------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------

-- (1) lines of a non-draft entry are immutable; new lines only on drafts
CREATE OR REPLACE FUNCTION gl_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE s journal_status;
BEGIN
  SELECT status INTO s FROM journal_entries WHERE id = coalesce(NEW.entry_id, OLD.entry_id);
  -- cascade deletes of a draft entry pass through here with s = NULL or 'draft'
  IF s IS NOT NULL AND s <> 'draft' THEN
    RAISE EXCEPTION 'journal entry is % — lines are immutable; post a reversal instead', s USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_gl_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION gl_lines_guard();

-- (2) posted entries: only the transition posted -> reversed (setting reversed_by) is allowed
CREATE OR REPLACE FUNCTION gl_entry_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'posted journal entries cannot be deleted' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'reversed' THEN
    RAISE EXCEPTION 'reversed journal entries are immutable' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'posted' THEN
    IF NEW.status = 'reversed' AND NEW.reversed_by IS NOT NULL
       AND (NEW.company_id, NEW.entry_date, NEW.number, NEW.period_id, NEW.memo, NEW.currency, NEW.posted_by, NEW.posted_at)
           IS NOT DISTINCT FROM
           (OLD.company_id, OLD.entry_date, OLD.number, OLD.period_id, OLD.memo, OLD.currency, OLD.posted_by, OLD.posted_at) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'posted journal entries are immutable; post a reversal instead' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_gl_entry_guard BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION gl_entry_guard();

-- (3) at posting time: balanced, ≥2 lines, open period, postable active accounts
CREATE OR REPLACE FUNCTION gl_validate_posting() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_dr numeric; v_cr numeric; v_n int; v_bad int; v_pstatus period_status;
BEGIN
  IF NEW.status = 'posted' AND (TG_OP = 'INSERT' OR OLD.status = 'draft') THEN
    SELECT coalesce(sum(debit),0), coalesce(sum(credit),0), count(*)
      INTO v_dr, v_cr, v_n FROM journal_lines WHERE entry_id = NEW.id;
    IF v_n < 2 THEN
      RAISE EXCEPTION 'journal entry needs at least two lines' USING ERRCODE = 'P0001';
    END IF;
    IF v_dr <> v_cr THEN
      RAISE EXCEPTION 'unbalanced journal entry: debit % <> credit %', v_dr, v_cr USING ERRCODE = 'P0001';
    END IF;
    SELECT count(*) INTO v_bad FROM journal_lines l JOIN accounts a ON a.id = l.account_id
     WHERE l.entry_id = NEW.id AND (NOT a.is_postable OR NOT a.is_active OR a.company_id <> NEW.company_id);
    IF v_bad > 0 THEN
      RAISE EXCEPTION 'journal entry uses non-postable, inactive or foreign-company accounts' USING ERRCODE = 'P0001';
    END IF;
    SELECT status INTO v_pstatus FROM fiscal_periods
     WHERE id = NEW.period_id AND company_id = NEW.company_id AND NEW.entry_date BETWEEN start_date AND end_date;
    IF v_pstatus IS NULL THEN
      RAISE EXCEPTION 'entry date % is not inside the assigned fiscal period', NEW.entry_date USING ERRCODE = 'P0001';
    END IF;
    IF v_pstatus <> 'open' THEN
      RAISE EXCEPTION 'fiscal period is closed' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER trg_gl_validate_posting AFTER INSERT OR UPDATE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION gl_validate_posting();

-- (4) cannot close a period that still has draft entries dated inside it
CREATE OR REPLACE FUNCTION gl_period_close_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v int;
BEGIN
  IF NEW.status = 'closed' AND OLD.status = 'open' THEN
    SELECT count(*) INTO v FROM journal_entries
     WHERE company_id = NEW.company_id AND status = 'draft' AND entry_date BETWEEN NEW.start_date AND NEW.end_date;
    IF v > 0 THEN
      RAISE EXCEPTION 'period has % draft entries; post or delete them before closing', v USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_gl_period_close_guard BEFORE UPDATE ON fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION gl_period_close_guard();

-- RLS
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['accounts','cost_centers','fiscal_years','fiscal_periods','exchange_rates','journal_entries','journal_lines']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY p_tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;
