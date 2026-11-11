-- =====================================================================
-- GOLDEN ERP — Migration 008: HR, attendance & payroll (Phase 5)
-- Rules ported from the existing «حضوري» system with its defaults
-- (Friday weekend, workday daily rate, late grace 10 min counted from
-- shift start, 2 free late occurrences/month, early grace 5 min, 1 free,
-- penalty cap 5 days, overtime needs approval). Statutory rates are NOT
-- assumed: they are pay components each company defines.
-- =====================================================================

CREATE TYPE rate_mode AS ENUM ('workdays', 'fixed');
CREATE TYPE penalty_mode AS ENUM ('none', 'minutes');
CREATE TYPE missing_out_rule AS ENUM ('flag_only', 'half_absent');

CREATE TABLE hr_settings (
  tenant_id                 uuid NOT NULL,
  company_id                uuid PRIMARY KEY,
  weekend_days              smallint[] NOT NULL DEFAULT '{5}',
  rate_mode                 rate_mode NOT NULL DEFAULT 'workdays',
  fixed_divisor             smallint NOT NULL DEFAULT 30 CHECK (fixed_divisor BETWEEN 20 AND 31),
  late_grace_min            smallint NOT NULL DEFAULT 10 CHECK (late_grace_min >= 0),
  late_from_start           boolean NOT NULL DEFAULT true,
  late_mode                 penalty_mode NOT NULL DEFAULT 'minutes',
  late_multiplier           numeric(6,3) NOT NULL DEFAULT 1 CHECK (late_multiplier >= 0),
  late_free_per_month       smallint NOT NULL DEFAULT 2 CHECK (late_free_per_month >= 0),
  early_grace_min           smallint NOT NULL DEFAULT 5 CHECK (early_grace_min >= 0),
  early_from_start          boolean NOT NULL DEFAULT true,
  early_mode                penalty_mode NOT NULL DEFAULT 'minutes',
  early_multiplier          numeric(6,3) NOT NULL DEFAULT 1 CHECK (early_multiplier >= 0),
  early_free_per_month      smallint NOT NULL DEFAULT 1 CHECK (early_free_per_month >= 0),
  penalty_cap_days          numeric(6,2) NOT NULL DEFAULT 5 CHECK (penalty_cap_days >= 0),   -- 0 = no cap
  overtime_enabled          boolean NOT NULL DEFAULT true,
  overtime_requires_approval boolean NOT NULL DEFAULT true,
  overtime_min_minutes      smallint NOT NULL DEFAULT 30 CHECK (overtime_min_minutes >= 0),
  overtime_multiplier       numeric(6,3) NOT NULL DEFAULT 1.5 CHECK (overtime_multiplier >= 0),
  overtime_offday_multiplier numeric(6,3) NOT NULL DEFAULT 2 CHECK (overtime_offday_multiplier >= 0),
  missing_out               missing_out_rule NOT NULL DEFAULT 'flag_only',
  punch_dedup_min           smallint NOT NULL DEFAULT 3 CHECK (punch_dedup_min >= 0),
  app_punch_enabled         boolean NOT NULL DEFAULT false,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id)
);

CREATE TABLE departments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  company_id   uuid NOT NULL,
  code         text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{1,20}$'),
  name_ar      text NOT NULL,
  -- where salaries of this department are expensed: administration vs production (direct labour)
  expense_role text NOT NULL DEFAULT 'salaries_expense' CHECK (expense_role IN ('salaries_expense', 'direct_labour', 'commission_expense', 'field_expense')),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, code),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id)
);

CREATE TABLE work_schedules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  company_id    uuid NOT NULL,
  code          text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{1,20}$'),
  name_ar       text NOT NULL,
  start_time    time NOT NULL,
  end_time      time NOT NULL,            -- end < start = night shift ending next day
  break_minutes smallint NOT NULL DEFAULT 0 CHECK (break_minutes >= 0),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, code),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  CHECK (start_time <> end_time)
);

CREATE TYPE employee_status AS ENUM ('active', 'terminated');

CREATE TABLE employees (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  company_id    uuid NOT NULL,
  code          text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{1,20}$'),
  full_name     text NOT NULL,
  national_id   text,
  phone         text,
  department_id uuid,
  branch_id     uuid,
  job_title     text,
  schedule_id   uuid,
  hire_date     date NOT NULL,
  end_date      date,
  status        employee_status NOT NULL DEFAULT 'active',
  basic_salary  numeric(20,4) NOT NULL DEFAULT 0 CHECK (basic_salary >= 0),   -- sensitive field (hr.salaries.view)
  bank_account  text,                                                        -- sensitive field
  device_pin    text,                                                        -- badge number on fingerprint devices
  user_id       uuid,                                                        -- login for self-service / link to rep
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, code),
  UNIQUE (tenant_id, device_pin),
  UNIQUE (user_id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  FOREIGN KEY (tenant_id, schedule_id) REFERENCES work_schedules(tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id),
  CHECK (end_date IS NULL OR end_date >= hire_date),
  CHECK ((status = 'terminated') = (end_date IS NOT NULL))
);
CREATE TRIGGER trg_employees_upd BEFORE UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TYPE component_kind AS ENUM ('earning', 'deduction');
CREATE TYPE component_method AS ENUM ('fixed', 'percent_of_basic');
-- allowances and deductions (incl. statutory ones the company defines: social security, income tax…)
CREATE TABLE pay_components (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  company_id  uuid NOT NULL,
  code        text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{1,20}$'),
  name_ar     text NOT NULL,
  kind        component_kind NOT NULL,
  method      component_method NOT NULL,
  default_value numeric(20,4) NOT NULL DEFAULT 0 CHECK (default_value >= 0),   -- amount, or % for percent_of_basic
  applies_to_all boolean NOT NULL DEFAULT false,
  is_active   boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, code),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  CHECK (method <> 'percent_of_basic' OR default_value <= 100)
);
CREATE TABLE employee_components (
  tenant_id    uuid NOT NULL,
  employee_id  uuid NOT NULL,
  component_id uuid NOT NULL,
  value        numeric(20,4) NOT NULL CHECK (value >= 0),
  PRIMARY KEY (employee_id, component_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, component_id) REFERENCES pay_components(tenant_id, id)
);

CREATE TABLE holidays (
  tenant_id  uuid NOT NULL,
  company_id uuid NOT NULL,
  day        date NOT NULL,
  name_ar    text NOT NULL,
  PRIMARY KEY (company_id, day),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id)
);

CREATE TABLE leave_types (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  company_id  uuid NOT NULL,
  code        text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{1,20}$'),
  name_ar     text NOT NULL,
  paid        boolean NOT NULL DEFAULT true,
  annual_days numeric(6,2) CHECK (annual_days >= 0),   -- NULL = unlimited (e.g. sick leave with certificate)
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, code),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id)
);

CREATE TYPE request_status AS ENUM ('submitted', 'approved', 'rejected');
CREATE TABLE leave_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  employee_id   uuid NOT NULL,
  leave_type_id uuid NOT NULL,
  from_date     date NOT NULL,
  to_date       date NOT NULL,
  reason        text,
  status        request_status NOT NULL DEFAULT 'submitted',
  created_by    uuid NOT NULL,
  decided_by    uuid,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, leave_type_id) REFERENCES leave_types(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES users(tenant_id, id),
  CHECK (to_date >= from_date)
);
CREATE INDEX ix_leave_emp ON leave_requests(employee_id, from_date);

-- fingerprint devices (ZKTeco iclock/ADMS). Serial numbers are globally unique across tenants.
CREATE TABLE attendance_devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  company_id    uuid NOT NULL,
  serial_number text NOT NULL UNIQUE CHECK (serial_number ~ '^[A-Za-z0-9_-]{4,40}$'),
  name          text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  last_seen_at  timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id)
);

CREATE TYPE punch_source AS ENUM ('device', 'manual', 'app', 'import');
-- punches are never deleted: a wrong punch is voided with a reason
CREATE TABLE punches (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  employee_id uuid NOT NULL,
  punched_at  timestamptz NOT NULL,
  source      punch_source NOT NULL,
  device_id   uuid,
  lat         numeric(9,6),
  lng         numeric(9,6),
  note        text,
  voided      boolean NOT NULL DEFAULT false,
  void_reason text,
  created_by  uuid,
  voided_by   uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, punched_at, source),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES attendance_devices(tenant_id, id),
  CHECK (NOT voided OR void_reason IS NOT NULL)
);
CREATE INDEX ix_punches_emp_time ON punches(employee_id, punched_at);
CREATE OR REPLACE FUNCTION punch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'punches cannot be deleted; void them with a reason' USING ERRCODE = 'P0001'; END IF;
  IF OLD.voided OR (NEW.employee_id, NEW.punched_at, NEW.source) IS DISTINCT FROM (OLD.employee_id, OLD.punched_at, OLD.source) THEN
    RAISE EXCEPTION 'punches are immutable; only voiding is allowed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_punch_guard BEFORE UPDATE OR DELETE ON punches FOR EACH ROW EXECUTE FUNCTION punch_guard();

CREATE TABLE unmatched_punches (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  device_id   uuid NOT NULL,
  pin         text NOT NULL,
  punched_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, pin, punched_at),
  FOREIGN KEY (tenant_id, device_id) REFERENCES attendance_devices(tenant_id, id)
);

-- HR decisions on a day (from حضوري «days»): excused absence, approved overtime, manual presence
CREATE TYPE day_decision AS ENUM ('excused_paid', 'excused_unpaid', 'approve_overtime', 'waive_late', 'waive_early');
CREATE TABLE attendance_decisions (
  tenant_id   uuid NOT NULL,
  employee_id uuid NOT NULL,
  day         date NOT NULL,
  decision    day_decision NOT NULL,
  minutes     int CHECK (minutes >= 0),
  reason      text NOT NULL,
  decided_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, day, decision),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES users(tenant_id, id)
);

-- advances / loans to employees (recovered by payroll installments)
CREATE TYPE loan_status AS ENUM ('active', 'settled');
CREATE TABLE employee_loans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  company_id       uuid NOT NULL,
  employee_id      uuid NOT NULL,
  number           text NOT NULL,
  loan_date        date NOT NULL,
  amount           numeric(20,4) NOT NULL CHECK (amount > 0),
  installment      numeric(20,4) NOT NULL CHECK (installment > 0),
  recovered        numeric(20,4) NOT NULL DEFAULT 0 CHECK (recovered >= 0),
  method           text NOT NULL CHECK (method IN ('cash', 'bank')),
  status           loan_status NOT NULL DEFAULT 'active',
  journal_entry_id uuid,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, number),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  CHECK (recovered <= amount),
  CHECK (installment <= amount)
);

CREATE TYPE payroll_status AS ENUM ('draft', 'approved', 'paid');
CREATE TABLE payroll_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  company_id       uuid NOT NULL,
  period           char(7) NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),
  status           payroll_status NOT NULL DEFAULT 'draft',
  total_earned     numeric(20,4) NOT NULL DEFAULT 0,
  total_net        numeric(20,4) NOT NULL DEFAULT 0,
  journal_entry_id uuid,
  payment_entry_id uuid,
  created_by       uuid NOT NULL,
  approved_by      uuid,
  approved_at      timestamptz,
  paid_by          uuid,
  paid_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, period),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries(tenant_id, id),
  FOREIGN KEY (tenant_id, payment_entry_id) REFERENCES journal_entries(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, paid_by) REFERENCES users(tenant_id, id)
);

CREATE TABLE payroll_lines (
  tenant_id        uuid NOT NULL,
  run_id           uuid NOT NULL,
  employee_id      uuid NOT NULL,
  department_role  text NOT NULL,
  basic            numeric(20,4) NOT NULL,
  daily_rate       numeric(20,6) NOT NULL,
  work_days        int NOT NULL,
  present_days     int NOT NULL,
  absent_days      numeric(6,2) NOT NULL,
  unpaid_leave_days numeric(6,2) NOT NULL,
  late_minutes     int NOT NULL,
  early_minutes    int NOT NULL,
  overtime_minutes int NOT NULL,
  earnings_components numeric(20,4) NOT NULL,
  overtime_pay     numeric(20,4) NOT NULL,
  absence_deduction numeric(20,4) NOT NULL,
  late_deduction   numeric(20,4) NOT NULL,
  early_deduction  numeric(20,4) NOT NULL,
  earned           numeric(20,4) NOT NULL,   -- basic + earnings + overtime − absence − late − early
  statutory_deductions numeric(20,4) NOT NULL,
  loan_recovery    numeric(20,4) NOT NULL,
  shortage_recovery numeric(20,4) NOT NULL,  -- rep cash/van shortages charged to the employee
  net              numeric(20,4) NOT NULL CHECK (net >= 0),
  PRIMARY KEY (run_id, employee_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES payroll_runs(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id),
  CHECK (earned = net + statutory_deductions + loan_recovery + shortage_recovery)
);
CREATE TABLE payroll_line_items (
  tenant_id    uuid NOT NULL,
  run_id       uuid NOT NULL,
  employee_id  uuid NOT NULL,
  component_id uuid NOT NULL,
  kind         component_kind NOT NULL,
  amount       numeric(20,4) NOT NULL,
  PRIMARY KEY (run_id, employee_id, component_id),
  FOREIGN KEY (run_id, employee_id) REFERENCES payroll_lines(run_id, employee_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, component_id) REFERENCES pay_components(tenant_id, id)
);
-- an approved/paid payroll is frozen
CREATE OR REPLACE FUNCTION payroll_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'approved payrolls cannot be deleted' USING ERRCODE = 'P0001'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'paid' THEN RAISE EXCEPTION 'paid payrolls are immutable' USING ERRCODE = 'P0001'; END IF;
  IF OLD.status = 'approved' AND (NEW.status <> 'paid' OR (NEW.total_earned, NEW.total_net) IS DISTINCT FROM (OLD.total_earned, OLD.total_net)) THEN
    RAISE EXCEPTION 'approved payrolls are frozen' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_payroll_guard BEFORE UPDATE OR DELETE ON payroll_runs FOR EACH ROW EXECUTE FUNCTION payroll_guard();
CREATE OR REPLACE FUNCTION payroll_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s payroll_status;
BEGIN
  SELECT status INTO s FROM payroll_runs WHERE id = coalesce(NEW.run_id, OLD.run_id);
  IF s IS NOT NULL AND s <> 'draft' THEN RAISE EXCEPTION 'lines of an approved payroll are frozen' USING ERRCODE = 'P0001'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_payroll_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON payroll_lines FOR EACH ROW EXECUTE FUNCTION payroll_lines_guard();

-- employee receivables recovered by payroll (rep shortages); one row per recovery
CREATE TABLE shortage_recoveries (
  tenant_id   uuid NOT NULL,
  employee_id uuid NOT NULL,
  run_id      uuid NOT NULL,
  amount      numeric(20,4) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (run_id, employee_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES payroll_runs(tenant_id, id) ON DELETE CASCADE
);

-- device ingestion happens before any tenant context exists: resolve by serial number only
CREATE OR REPLACE FUNCTION device_by_serial(p_sn text) RETURNS TABLE (id uuid, tenant_id uuid, company_id uuid, is_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT d.id, d.tenant_id, d.company_id, d.is_active FROM attendance_devices d WHERE d.serial_number = p_sn
$$;
GRANT EXECUTE ON FUNCTION device_by_serial(text) TO golden_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hr_settings','departments','work_schedules','employees','pay_components','employee_components','holidays','leave_types','leave_requests',
    'attendance_devices','punches','unmatched_punches','attendance_decisions','employee_loans','payroll_runs','payroll_lines','payroll_line_items','shortage_recoveries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY p_tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO golden_app', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE punches_id_seq, unmatched_punches_id_seq TO golden_app;
REVOKE DELETE ON punches FROM golden_app;

INSERT INTO permissions (code, module_code, name_ar, name_en, is_sensitive) VALUES
  ('hr.employees.view',    'hr', 'عرض الموظفين', 'View employees', false),
  ('hr.employees.manage',  'hr', 'إدارة الموظفين والأقسام والدوامات', 'Manage employees, departments, schedules', false),
  ('hr.salaries.view',     'hr', 'رؤية الرواتب والبيانات المصرفية (حقول حساسة)', 'See salaries & bank data (sensitive fields)', true),
  ('hr.attendance.view',   'hr', 'عرض الحضور والانصراف', 'View attendance', false),
  ('hr.attendance.manage', 'hr', 'تصحيح البصمات وقرارات الأيام', 'Correct punches & day decisions', true),
  ('hr.leave.approve',     'hr', 'اعتماد الإجازات', 'Approve leave', false),
  ('hr.settings.manage',   'hr', 'ضوابط الحضور والعطل وأنواع الإجازات وأجهزة البصمة', 'Attendance rules, holidays, leave types, devices', true),
  ('hr.self.view',         'hr', 'بوابة الموظف: حضوري وقسائم راتبي', 'Self-service: my attendance & payslips', false),
  ('hr.self.request',      'hr', 'بوابة الموظف: طلب إجازة وتسجيل الحضور من التطبيق', 'Self-service: leave requests & app punch', false),
  ('payroll.runs.prepare', 'payroll', 'إعداد مسير الرواتب', 'Prepare payroll', false),
  ('payroll.runs.approve', 'payroll', 'اعتماد وترحيل مسير الرواتب', 'Approve & post payroll', true),
  ('payroll.runs.pay',     'payroll', 'صرف الرواتب', 'Pay salaries', true),
  ('payroll.components.manage', 'payroll', 'بنود الرواتب (بدلات واستقطاعات)', 'Pay components', true),
  ('payroll.loans.manage', 'payroll', 'السلف والقروض', 'Employee loans & advances', true);
