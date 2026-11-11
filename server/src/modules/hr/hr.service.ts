import type { Db } from "../../db/pool.js";
import type { UserCtx } from "../../core/auth.js";
import { E } from "../../core/errors.js";
import { audit } from "../../core/audit.js";
import { docNumber, minorUnits, postJournal } from "../erp/common.js";
import { computeDay, computePay, type DayInput, type HrSettings, type Schedule } from "./engine.js";

const one = async (db: Db, sql: string, args: unknown[]) => (await db.query(sql, args)).rows[0];
const log = (db: Db, u: UserCtx, action: string, entityType: string, entityId: string, after?: unknown, before?: unknown) =>
  audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action, entityType, entityId, after, before });

export async function settingsOf(db: Db, u: UserCtx, companyId: string) {
  let s = await one(db, "SELECT * FROM hr_settings WHERE company_id = $1", [companyId]);
  if (!s) s = await one(db, "INSERT INTO hr_settings (tenant_id, company_id) VALUES ($1,$2) RETURNING *", [u.tenantId, companyId]);
  return s;
}
export function toEngine(s: any): HrSettings {
  return {
    weekendDays: s.weekend_days, rateMode: s.rate_mode, fixedDivisor: s.fixed_divisor,
    late: { grace: s.late_grace_min, fromStart: s.late_from_start, mode: s.late_mode, multiplier: s.late_multiplier, freePerMonth: s.late_free_per_month },
    early: { grace: s.early_grace_min, fromStart: s.early_from_start, mode: s.early_mode, multiplier: s.early_multiplier, freePerMonth: s.early_free_per_month },
    penaltyCapDays: s.penalty_cap_days,
    overtime: { enabled: s.overtime_enabled, requiresApproval: s.overtime_requires_approval, minMinutes: s.overtime_min_minutes, multiplier: s.overtime_multiplier, offdayMultiplier: s.overtime_offday_multiplier },
    missingOut: s.missing_out, dedupMin: s.punch_dedup_min,
  };
}

/** sensitive fields (salary, bank account) are removed unless the viewer holds hr.salaries.view */
export function mask(u: UserCtx, e: any) {
  if (u.permissions.has("hr.salaries.view")) return e;
  const { basic_salary: _b, bank_account: _a, ...rest } = e;
  return { ...rest, basic_salary: null, bank_account: null, masked: true };
}

const monthDays = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${period}-${String(i + 1).padStart(2, "0")}`);
};
const toMin = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + (m || 0); };

/** builds the engine input for one employee-month: punches in local time, leave, holidays, HR decisions */
export async function attendanceMonth(db: Db, emp: any, period: string, cfgRow: any) {
  const tz = (await one(db, "SELECT timezone FROM tenants WHERE id = $1", [emp.tenant_id])).timezone as string;
  const sch = await one(db, "SELECT to_char(start_time, 'HH24:MI') AS start, to_char(end_time, 'HH24:MI') AS end, break_minutes FROM work_schedules WHERE id = $1", [emp.schedule_id]);
  if (!sch) throw E.rule("NO_SCHEDULE", `الموظف ${emp.code} بلا دوام محدد`, `Employee ${emp.code} has no work schedule`);
  const schedule: Schedule = { start: sch.start, end: sch.end, breakMinutes: sch.break_minutes };
  const days = monthDays(period);
  // punches as "local minutes since epoch"; a punch belongs to day D if it falls in [D + start − 6h, D + start + 18h)
  const punches = (await db.query(
    `SELECT floor(extract(epoch FROM (punched_at AT TIME ZONE $2)) / 60)::bigint AS lm FROM punches
      WHERE employee_id = $1 AND NOT voided AND punched_at >= ($3::date - 1)::timestamp AT TIME ZONE $2 AND punched_at < ($4::date + 2)::timestamp AT TIME ZONE $2 ORDER BY punched_at`,
    [emp.id, tz, days[0], days[days.length - 1]])).rows.map((r) => Number(r.lm));
  const holidays = new Set((await db.query("SELECT day::text FROM holidays WHERE company_id = $1 AND day BETWEEN $2 AND $3", [emp.company_id, days[0], days[days.length - 1]])).rows.map((r) => r.day));
  const leaves = (await db.query(`SELECT r.from_date::text, r.to_date::text, t.paid FROM leave_requests r JOIN leave_types t ON t.id = r.leave_type_id
     WHERE r.employee_id = $1 AND r.status = 'approved' AND r.to_date >= $2 AND r.from_date <= $3`, [emp.id, days[0], days[days.length - 1]])).rows;
  const decisions = (await db.query("SELECT day::text, decision, minutes FROM attendance_decisions WHERE employee_id = $1 AND day BETWEEN $2 AND $3", [emp.id, days[0], days[days.length - 1]])).rows;
  const start = toMin(schedule.start);
  const inputs: DayInput[] = days.map((d) => {
    const dayStart = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 60000;
    const own = punches.filter((lm) => lm >= dayStart + start - 360 && lm < dayStart + start + 1080).map((lm) => lm - dayStart);
    const lv = leaves.find((l) => l.from_date <= d && l.to_date >= d);
    const dec = decisions.filter((x) => x.day === d);
    return { date: d, punches: own, holiday: holidays.has(d), leave: lv ? (lv.paid ? "paid" : "unpaid") : null, decisions: new Set(dec.map((x) => x.decision)),
      approvedOvertimeMinutes: dec.find((x) => x.decision === "approve_overtime" && x.minutes !== null)?.minutes ?? undefined,
      employed: d >= emp.hire_date && (!emp.end_date || d <= emp.end_date) };
  });
  const cfg = toEngine(cfgRow);
  return { schedule, cfg, days: inputs.map((i) => computeDay(i, schedule, cfg)) };
}

// ------------------------------------------------------------------ device ingestion (ZKTeco iclock / ADMS)
/** ATTLOG lines: "PIN\tYYYY-MM-DD HH:MM:SS\t…" in the device's local time (the tenant time zone) */
export async function ingestAttlog(db: Db, device: { id: string; tenant_id: string }, body: string) {
  const tz = (await one(db, "SELECT timezone FROM tenants WHERE id = $1", [device.tenant_id])).timezone;
  let stored = 0, unmatched = 0, duplicates = 0;
  for (const line of body.split(/\r?\n/)) {
    const [pin, ts] = line.split("\t");
    if (!pin || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts ?? "")) continue;
    const emp = await one(db, "SELECT id FROM employees WHERE device_pin = $1 AND status = 'active'", [pin.trim()]);
    if (!emp) {
      await db.query("INSERT INTO unmatched_punches (tenant_id, device_id, pin, punched_at) VALUES ($1,$2,$3,$4::timestamp AT TIME ZONE $5) ON CONFLICT DO NOTHING", [device.tenant_id, device.id, pin.trim(), ts, tz]);
      unmatched++; continue;
    }
    const r = await db.query(`INSERT INTO punches (tenant_id, employee_id, punched_at, source, device_id) VALUES ($1,$2,$3::timestamp AT TIME ZONE $4,'device',$5) ON CONFLICT DO NOTHING`,
      [device.tenant_id, emp.id, ts, tz, device.id]);
    r.rowCount ? stored++ : duplicates++;
  }
  await db.query("UPDATE attendance_devices SET last_seen_at = now() WHERE id = $1", [device.id]);
  return { stored, unmatched, duplicates };
}

// ------------------------------------------------------------------ leave
export async function decideLeave(db: Db, u: UserCtx, id: string, approve: boolean) {
  const r = await one(db, "SELECT r.*, e.user_id FROM leave_requests r JOIN employees e ON e.id = r.employee_id WHERE r.id = $1 FOR UPDATE OF r", [id]);
  if (!r) throw E.notFound("leave request");
  if (r.status !== "submitted") throw E.rule("ALREADY_PROCESSED", "تمت معالجة الطلب مسبقًا", "Request already processed");
  if (r.user_id === u.userId) throw E.sod();
  const t = await one(db, "SELECT * FROM leave_types WHERE id = $1", [r.leave_type_id]);
  if (approve && t.annual_days !== null) {
    const y = r.from_date.slice(0, 4);
    const used = await one(db, `SELECT coalesce(sum(to_date - from_date + 1), 0) AS d FROM leave_requests WHERE employee_id = $1 AND leave_type_id = $2 AND status = 'approved' AND to_char(from_date, 'YYYY') = $3`,
      [r.employee_id, r.leave_type_id, y]);
    const want = (await one(db, "SELECT ($2::date - $1::date + 1) AS d", [r.from_date, r.to_date])).d;
    if (Number(used.d) + Number(want) > Number(t.annual_days))
      throw E.rule("LEAVE_BALANCE_EXCEEDED", `رصيد ${t.name_ar} غير كافٍ (المستخدم ${used.d} من ${Number(t.annual_days)} يومًا)`, `Insufficient ${t.code} balance`, { used: used.d, allowed: t.annual_days });
  }
  await db.query("UPDATE leave_requests SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1", [id, approve ? "approved" : "rejected", u.userId]);
  await log(db, u, approve ? "leave.approved" : "leave.rejected", "leave_request", id);
  return one(db, "SELECT * FROM leave_requests WHERE id = $1", [id]);
}

// ------------------------------------------------------------------ loans
export async function createLoan(db: Db, u: UserCtx, b: { companyId: string; employeeId: string; loanDate: string; amount: string; installment: string; method: "cash" | "bank" }) {
  const emp = await one(db, "SELECT * FROM employees WHERE id = $1 AND company_id = $2 AND status = 'active'", [b.employeeId, b.companyId]);
  if (!emp) throw E.validation([{ path: "employeeId", message: "active employee not found" }]);
  const number = await docNumber(db, u, b.companyId, "LN", b.loanDate);
  const loan = await one(db, `INSERT INTO employee_loans (tenant_id, company_id, employee_id, number, loan_date, amount, installment, method, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [u.tenantId, b.companyId, b.employeeId, number, b.loanDate, b.amount, b.installment, b.method, u.userId]);
  const je = await postJournal(db, u, { companyId: b.companyId, date: b.loanDate, memo: `سلفة ${number} — ${emp.full_name}`, sourceType: "employee_loan", sourceId: loan.id,
    parts: [{ role: "employee_advances", amount: b.amount }, { role: b.method === "cash" ? "cash_main" : "bank_main", amount: "-" + b.amount }] });
  await db.query("UPDATE employee_loans SET journal_entry_id = $2 WHERE id = $1", [loan.id, je]);
  await log(db, u, "loan.created", "employee_loan", loan.id, b);
  return { ...loan, journal_entry_id: je };
}

/** shortages charged to an employee who is (or was) a rep, not yet recovered by payroll */
async function shortageOutstanding(db: Db, employeeId: string, userId: string | null) {
  if (!userId) return "0";
  return (await one(db, `SELECT greatest(
      coalesce((SELECT sum(h.declared_amount - h.counted_amount) FROM cash_handovers h JOIN sales_reps r ON r.id = h.rep_id WHERE r.user_id = $2 AND h.status = 'confirmed'), 0)
    + coalesce((SELECT sum(s.shortage_value) FROM van_settlements s JOIN sales_reps r ON r.id = s.rep_id WHERE r.user_id = $2 AND s.status = 'approved'), 0)
    - coalesce((SELECT sum(amount) FROM shortage_recoveries WHERE employee_id = $1), 0), 0)::text AS o`, [employeeId, userId])).o as string;
}

// ------------------------------------------------------------------ payroll
export async function preparePayroll(db: Db, u: UserCtx, b: { companyId: string; period: string }) {
  let run = await one(db, "SELECT * FROM payroll_runs WHERE company_id = $1 AND period = $2 FOR UPDATE", [b.companyId, b.period]);
  if (run && run.status !== "draft") throw E.rule("PAYROLL_LOCKED", "مسير هذا الشهر معتمد ولا يمكن إعادة احتسابه", "This month's payroll is approved and locked");
  if (!run) run = await one(db, "INSERT INTO payroll_runs (tenant_id, company_id, period, created_by) VALUES ($1,$2,$3,$4) RETURNING *", [u.tenantId, b.companyId, b.period, u.userId]);
  else await db.query("UPDATE payroll_runs SET created_by = $2 WHERE id = $1", [run.id, u.userId]); // the recalculator is the preparer (SoD)
  await db.query("DELETE FROM payroll_lines WHERE run_id = $1", [run.id]);
  const first = `${b.period}-01`;
  const last = (await one(db, "SELECT (($1::date + interval '1 month') - interval '1 day')::date::text AS d", [first])).d;
  const cfgRow = await settingsOf(db, u, b.companyId);
  const m = await minorUnits(db, b.companyId);
  const comps = (await db.query("SELECT * FROM pay_components WHERE company_id = $1 AND is_active", [b.companyId])).rows;
  const emps = (await db.query(`SELECT e.*, e.hire_date::text AS hire_date, e.end_date::text AS end_date, coalesce(d.expense_role, 'salaries_expense') AS expense_role
     FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.company_id = $1 AND e.hire_date <= $3 AND (e.end_date IS NULL OR e.end_date >= $2) ORDER BY e.code`, [b.companyId, first, last])).rows;
  let totalEarned = "0", totalNet = "0";
  for (const e of emps) {
    const { days, schedule, cfg } = await attendanceMonth(db, e, b.period, cfgRow);
    const own = new Map((await db.query("SELECT component_id, value FROM employee_components WHERE employee_id = $1", [e.id])).rows.map((x) => [x.component_id, x.value]));
    const components = comps.filter((c) => c.applies_to_all || own.has(c.id)).map((c) => ({ id: c.id, kind: c.kind, method: c.method, value: own.get(c.id) ?? c.default_value }));
    const loans = await one(db, "SELECT coalesce(sum(least(installment, amount - recovered)), 0)::text AS i FROM employee_loans WHERE employee_id = $1 AND status = 'active' AND loan_date <= $2", [e.id, last]);
    const pay = computePay({ basic: e.basic_salary, minorUnits: m, days, schedule, cfg, components, loanInstallments: loans.i, shortageOutstanding: await shortageOutstanding(db, e.id, e.user_id) });
    await db.query(`INSERT INTO payroll_lines (tenant_id, run_id, employee_id, department_role, basic, daily_rate, work_days, present_days, absent_days, unpaid_leave_days, late_minutes, early_minutes,
        overtime_minutes, earnings_components, overtime_pay, absence_deduction, late_deduction, early_deduction, earned, statutory_deductions, loan_recovery, shortage_recovery, net)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
      [u.tenantId, run.id, e.id, e.expense_role, e.basic_salary, pay.dailyRate, pay.workDays, pay.presentDays, pay.absentDays, pay.unpaidLeaveDays, pay.lateMinutes, pay.earlyMinutes,
       pay.overtimeMinutes, pay.earningsComponents, pay.overtimePay, pay.absenceDeduction, pay.lateDeduction, pay.earlyDeduction, pay.earned, pay.statutoryDeductions, pay.loanRecovery, pay.shortageRecovery, pay.net]);
    for (const it of pay.items) await db.query("INSERT INTO payroll_line_items (tenant_id, run_id, employee_id, component_id, kind, amount) VALUES ($1,$2,$3,$4,$5,$6)", [u.tenantId, run.id, e.id, it.id, it.kind, it.amount]);
    totalEarned = (await one(db, "SELECT ($1::numeric + $2::numeric)::text AS t", [totalEarned, pay.earned])).t;
    totalNet = (await one(db, "SELECT ($1::numeric + $2::numeric)::text AS t", [totalNet, pay.net])).t;
  }
  await db.query("UPDATE payroll_runs SET total_earned = $2, total_net = $3 WHERE id = $1", [run.id, totalEarned, totalNet]);
  await log(db, u, "payroll.prepared", "payroll_run", run.id, { period: b.period, employees: emps.length, totalEarned, totalNet });
  return getPayroll(db, u, run.id);
}

export async function getPayroll(db: Db, u: UserCtx, id: string) {
  const run = await one(db, "SELECT * FROM payroll_runs WHERE id = $1", [id]);
  if (!run) throw E.notFound("payroll run");
  const lines = (await db.query(`SELECT l.*, e.code, e.full_name, d.name_ar AS department FROM payroll_lines l JOIN employees e ON e.id = l.employee_id
     LEFT JOIN departments d ON d.id = e.department_id WHERE l.run_id = $1 ORDER BY e.code`, [id])).rows;
  const sensitive = u.permissions.has("hr.salaries.view");
  return { ...run, lines: sensitive ? lines : lines.map((l) => ({ code: l.code, full_name: l.full_name, department: l.department, work_days: l.work_days, present_days: l.present_days,
    absent_days: l.absent_days, late_minutes: l.late_minutes, early_minutes: l.early_minutes, overtime_minutes: l.overtime_minutes, masked: true })) };
}

/** approval = posting: Dr expense (per department) / Cr salaries payable, payroll deductions payable, employee advances */
export async function approvePayroll(db: Db, u: UserCtx, id: string) {
  const run = await one(db, "SELECT * FROM payroll_runs WHERE id = $1 FOR UPDATE", [id]);
  if (!run) throw E.notFound("payroll run");
  if (run.status !== "draft") throw E.rule("ALREADY_POSTED", "المسير معتمد مسبقًا", "Payroll already approved");
  if (u.enforceSod && run.created_by === u.userId) throw E.sod();
  const lines = (await db.query("SELECT * FROM payroll_lines WHERE run_id = $1", [id])).rows;
  if (!lines.length) throw E.rule("EMPTY_DOCUMENT", "المسير فارغ", "Payroll has no lines");
  const sums = await one(db, `SELECT sum(net)::text AS net, sum(statutory_deductions)::text AS stat, sum(loan_recovery + shortage_recovery)::text AS rec FROM payroll_lines WHERE run_id = $1`, [id]);
  const byRole = (await db.query("SELECT department_role AS role, sum(earned)::text AS amt FROM payroll_lines WHERE run_id = $1 GROUP BY department_role", [id])).rows;
  const date = (await one(db, "SELECT (($1 || '-01')::date + interval '1 month' - interval '1 day')::date::text AS d", [run.period])).d;
  const je = await postJournal(db, u, { companyId: run.company_id, date, memo: `مسير رواتب ${run.period}`, sourceType: "payroll_run", sourceId: id, parts: [
    ...byRole.map((r) => ({ role: r.role, amount: r.amt })),
    { role: "salaries_payable", amount: "-" + sums.net }, { role: "payroll_deductions_payable", amount: "-" + sums.stat }, { role: "employee_advances", amount: "-" + sums.rec } ] });
  // apply recoveries: loan installments oldest first, rep shortages recorded per employee
  for (const l of lines) {
    let left = l.loan_recovery;
    for (const loan of (await db.query("SELECT * FROM employee_loans WHERE employee_id = $1 AND status = 'active' ORDER BY loan_date, number FOR UPDATE", [l.employee_id])).rows) {
      if (Number(left) <= 0) break;
      const take = (await one(db, "SELECT least($1::numeric, $2::numeric, $3::numeric - $4::numeric)::text AS t", [left, loan.installment, loan.amount, loan.recovered])).t;
      await db.query("UPDATE employee_loans SET recovered = recovered + $2, status = CASE WHEN recovered + $2 >= amount THEN 'settled'::loan_status ELSE status END WHERE id = $1", [loan.id, take]);
      left = (await one(db, "SELECT ($1::numeric - $2::numeric)::text AS r", [left, take])).r;
    }
    if (Number(l.shortage_recovery) > 0) await db.query("INSERT INTO shortage_recoveries (tenant_id, employee_id, run_id, amount) VALUES ($1,$2,$3,$4)", [u.tenantId, l.employee_id, id, l.shortage_recovery]);
  }
  await db.query("UPDATE payroll_runs SET status = 'approved', journal_entry_id = $2, approved_by = $3, approved_at = now() WHERE id = $1", [id, je, u.userId]);
  await log(db, u, "payroll.approved", "payroll_run", id, { journal: je, net: sums.net });
  return getPayroll(db, u, id);
}

export async function payPayroll(db: Db, u: UserCtx, id: string, method: "bank" | "cash", date: string) {
  const run = await one(db, "SELECT * FROM payroll_runs WHERE id = $1 FOR UPDATE", [id]);
  if (!run) throw E.notFound("payroll run");
  if (run.status !== "approved") throw E.rule("NOT_APPROVED", "يُصرف المسير بعد اعتماده فقط", "Only approved payrolls can be paid");
  const je = await postJournal(db, u, { companyId: run.company_id, date, memo: `صرف رواتب ${run.period}`, sourceType: "payroll_payment", sourceId: id,
    parts: [{ role: "salaries_payable", amount: run.total_net }, { role: method === "bank" ? "bank_main" : "cash_main", amount: "-" + run.total_net }] });
  await db.query("UPDATE payroll_runs SET status = 'paid', payment_entry_id = $2, paid_by = $3, paid_at = now() WHERE id = $1", [id, je, u.userId]);
  await log(db, u, "payroll.paid", "payroll_run", id, { method, journal: je });
  return getPayroll(db, u, id);
}

export async function payslip(db: Db, runId: string, employeeId: string) {
  const l = await one(db, `SELECT l.*, r.period, r.status, e.code, e.full_name, e.job_title, d.name_ar AS department FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id
     JOIN employees e ON e.id = l.employee_id LEFT JOIN departments d ON d.id = e.department_id WHERE l.run_id = $1 AND l.employee_id = $2`, [runId, employeeId]);
  if (!l) throw E.notFound("payslip");
  const items = (await db.query("SELECT i.kind, i.amount, c.code, c.name_ar FROM payroll_line_items i JOIN pay_components c ON c.id = i.component_id WHERE i.run_id = $1 AND i.employee_id = $2 ORDER BY i.kind, c.code", [runId, employeeId])).rows;
  return { ...l, items };
}
