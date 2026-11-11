import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { can, tdb } from "../../core/auth.js";
import { parse, zUuid, zMoney, zDate } from "../../core/http.js";
import { E } from "../../core/errors.js";
import { audit } from "../../core/audit.js";
import { withAnonymous, withTenant } from "../../db/pool.js";
import * as hr from "./hr.service.js";

const H = { tags: ["HR"] };
const P = { tags: ["Payroll"] };
const S = { tags: ["Employee self-service"] };
const id$ = z.object({ id: zUuid });
const zCode = z.string().regex(/^[A-Z0-9_-]{1,20}$/);
const zPeriod = z.string().regex(/^\d{4}-\d{2}$/);
const zTime = z.string().regex(/^\d{2}:\d{2}$/);
const ac = (req: any) => ({ tenantId: req.user.tenantId, actorType: "user" as const, actorId: req.user.userId, ip: req.ip, requestId: req.id });

export async function hrRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- reference data
  for (const [path, table, perm, schema, cols] of [
    ["/hr/departments", "departments", "hr.employees.manage", z.object({ companyId: zUuid, code: zCode, nameAr: z.string().min(2), expenseRole: z.enum(["salaries_expense", "direct_labour", "commission_expense", "field_expense"]).default("salaries_expense") }),
      (b: any) => [["code", b.code], ["name_ar", b.nameAr], ["expense_role", b.expenseRole]]],
    ["/hr/schedules", "work_schedules", "hr.employees.manage", z.object({ companyId: zUuid, code: zCode, nameAr: z.string().min(2), start: zTime, end: zTime, breakMinutes: z.number().int().min(0).max(240).default(0) }),
      (b: any) => [["code", b.code], ["name_ar", b.nameAr], ["start_time", b.start], ["end_time", b.end], ["break_minutes", b.breakMinutes]]],
    ["/hr/leave-types", "leave_types", "hr.settings.manage", z.object({ companyId: zUuid, code: zCode, nameAr: z.string().min(2), paid: z.boolean().default(true), annualDays: zMoney.nullable().optional() }),
      (b: any) => [["code", b.code], ["name_ar", b.nameAr], ["paid", b.paid], ["annual_days", b.annualDays ?? null]]],
    ["/hr/devices", "attendance_devices", "hr.settings.manage", z.object({ companyId: zUuid, serialNumber: z.string().regex(/^[A-Za-z0-9_-]{4,40}$/), name: z.string().min(2) }),
      (b: any) => [["serial_number", b.serialNumber], ["name", b.name]]],
    ["/payroll/components", "pay_components", "payroll.components.manage", z.object({ companyId: zUuid, code: zCode, nameAr: z.string().min(2), kind: z.enum(["earning", "deduction"]),
      method: z.enum(["fixed", "percent_of_basic"]), defaultValue: zMoney.default("0"), appliesToAll: z.boolean().default(false) }),
      (b: any) => [["code", b.code], ["name_ar", b.nameAr], ["kind", b.kind], ["method", b.method], ["default_value", b.defaultValue], ["applies_to_all", b.appliesToAll]]],
  ] as const) {
    const viewPerm = table === "pay_components" ? "payroll.runs.prepare" : "hr.employees.view";
    app.get(path, { schema: { ...(path.startsWith("/payroll") ? P : H), summary: `List ${table}` }, preHandler: can(viewPerm) }, async (req) => {
      const q = parse(z.object({ companyId: zUuid }), req.query);
      return tdb(req, async (db) => (await db.query(`SELECT * FROM ${table} WHERE company_id = $1 ORDER BY 1`, [q.companyId])).rows);
    });
    app.post(path, { schema: { ...(path.startsWith("/payroll") ? P : H), summary: `Create ${table}` }, preHandler: can(perm) }, async (req, reply) => {
      const b = parse(schema as z.ZodTypeAny, req.body) as any;
      const kv = (cols as any)(b) as [string, unknown][];
      return reply.code(201).send(await tdb(req, async (db) => {
        const r = (await db.query(`INSERT INTO ${table} (tenant_id, company_id, ${kv.map((x) => x[0]).join(", ")}) VALUES ($1, $2, ${kv.map((_, i) => `$${i + 3}`).join(", ")}) RETURNING *`,
          [req.user!.tenantId, b.companyId, ...kv.map((x) => x[1])])).rows[0];
        await audit(db, { ...ac(req), action: `${table}.created`, entityType: table, entityId: r.id ?? b.companyId, after: r });
        return r;
      }));
    });
  }

  app.get("/hr/holidays", { schema: { ...H, summary: "Public holidays" }, preHandler: can("hr.employees.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid }), req.query);
    return tdb(req, async (db) => (await db.query("SELECT * FROM holidays WHERE company_id = $1 ORDER BY day", [q.companyId])).rows);
  });
  app.post("/hr/holidays", { schema: { ...H, summary: "Add a public holiday" }, preHandler: can("hr.settings.manage") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, day: zDate, nameAr: z.string().min(2) }), req.body);
    return reply.code(201).send(await tdb(req, async (db) => (await db.query("INSERT INTO holidays (tenant_id, company_id, day, name_ar) VALUES ($1,$2,$3,$4) RETURNING *", [req.user!.tenantId, b.companyId, b.day, b.nameAr])).rows[0]));
  });

  app.get("/hr/settings", { schema: { ...H, summary: "Attendance & payroll rules (حضوري defaults)" }, preHandler: can("hr.employees.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid }), req.query);
    return tdb(req, (db) => hr.settingsOf(db, req.user!, q.companyId));
  });
  app.patch("/hr/settings", { schema: { ...H, summary: "Update attendance & payroll rules" }, preHandler: can("hr.settings.manage") }, async (req) => {
    const b = parse(z.object({ companyId: zUuid, weekendDays: z.array(z.number().int().min(0).max(6)).max(3).optional(), rateMode: z.enum(["workdays", "fixed"]).optional(),
      lateGraceMin: z.number().int().min(0).max(120).optional(), lateFreePerMonth: z.number().int().min(0).max(31).optional(), lateMode: z.enum(["none", "minutes"]).optional(),
      earlyGraceMin: z.number().int().min(0).max(120).optional(), penaltyCapDays: zMoney.optional(), overtimeRequiresApproval: z.boolean().optional(),
      overtimeMultiplier: zMoney.optional(), appPunchEnabled: z.boolean().optional() }), req.body);
    return tdb(req, async (db) => {
      const before = await hr.settingsOf(db, req.user!, b.companyId);
      const r = (await db.query(`UPDATE hr_settings SET weekend_days = coalesce($2, weekend_days), rate_mode = coalesce($3, rate_mode), late_grace_min = coalesce($4, late_grace_min),
          late_free_per_month = coalesce($5, late_free_per_month), late_mode = coalesce($6, late_mode), early_grace_min = coalesce($7, early_grace_min), penalty_cap_days = coalesce($8, penalty_cap_days),
          overtime_requires_approval = coalesce($9, overtime_requires_approval), overtime_multiplier = coalesce($10, overtime_multiplier), app_punch_enabled = coalesce($11, app_punch_enabled), updated_at = now()
        WHERE company_id = $1 RETURNING *`, [b.companyId, b.weekendDays ?? null, b.rateMode ?? null, b.lateGraceMin ?? null, b.lateFreePerMonth ?? null, b.lateMode ?? null, b.earlyGraceMin ?? null,
          b.penaltyCapDays ?? null, b.overtimeRequiresApproval ?? null, b.overtimeMultiplier ?? null, b.appPunchEnabled ?? null])).rows[0];
      await audit(db, { ...ac(req), action: "hr_settings.updated", entityType: "hr_settings", entityId: b.companyId, before, after: r });
      return r;
    });
  });

  // ---------------------------------------------------------------- employees (salary = sensitive field)
  app.get("/hr/employees", { schema: { ...H, summary: "Employees (salary and bank account masked without hr.salaries.view)" }, preHandler: can("hr.employees.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid, q: z.string().optional(), status: z.enum(["active", "terminated"]).optional() }), req.query);
    return tdb(req, async (db) => (await db.query(`SELECT e.*, d.name_ar AS department, s.code AS schedule_code FROM employees e LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN work_schedules s ON s.id = e.schedule_id WHERE e.company_id = $1 AND ($2::text IS NULL OR e.full_name ILIKE '%'||$2||'%' OR e.code ILIKE '%'||$2||'%')
       AND ($3::employee_status IS NULL OR e.status = $3) ORDER BY e.code`, [q.companyId, q.q ?? null, q.status ?? null])).rows.map((e) => hr.mask(req.user!, e)));
  });
  const zEmp = z.object({ companyId: zUuid, code: zCode, fullName: z.string().min(2), nationalId: z.string().optional(), phone: z.string().optional(), departmentId: zUuid.nullable().optional(),
    branchId: zUuid.nullable().optional(), jobTitle: z.string().optional(), scheduleId: zUuid.nullable().optional(), hireDate: zDate, basicSalary: zMoney.default("0"),
    bankAccount: z.string().optional(), devicePin: z.string().regex(/^\d{1,12}$/).optional(), userId: zUuid.nullable().optional(),
    components: z.array(z.object({ componentId: zUuid, value: zMoney })).max(50).default([]) });
  app.post("/hr/employees", { schema: { ...H, summary: "Hire an employee" }, preHandler: can("hr.employees.manage") }, async (req, reply) => {
    const b = parse(zEmp, req.body);
    if ((Number(b.basicSalary) > 0 || b.bankAccount || b.components.length) && !req.user!.permissions.has("hr.salaries.view")) throw E.forbidden("hr.salaries.view");
    return reply.code(201).send(await tdb(req, async (db) => {
      const r = (await db.query(`INSERT INTO employees (tenant_id, company_id, code, full_name, national_id, phone, department_id, branch_id, job_title, schedule_id, hire_date, basic_salary, bank_account, device_pin, user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`, [req.user!.tenantId, b.companyId, b.code, b.fullName, b.nationalId ?? null, b.phone ?? null, b.departmentId ?? null,
        b.branchId ?? null, b.jobTitle ?? null, b.scheduleId ?? null, b.hireDate, b.basicSalary, b.bankAccount ?? null, b.devicePin ?? null, b.userId ?? null])).rows[0];
      for (const c of b.components) await db.query("INSERT INTO employee_components (tenant_id, employee_id, component_id, value) VALUES ($1,$2,$3,$4)", [req.user!.tenantId, r.id, c.componentId, c.value]);
      await audit(db, { ...ac(req), action: "employee.hired", entityType: "employee", entityId: r.id, after: { ...b, basicSalary: "[sensitive]", bankAccount: b.bankAccount ? "[sensitive]" : undefined } });
      return hr.mask(req.user!, r);
    }));
  });
  app.patch("/hr/employees/:id", { schema: { ...H, summary: "Update employee / salary (sensitive) / terminate" }, preHandler: can("hr.employees.manage") }, async (req) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ fullName: z.string().min(2).optional(), departmentId: zUuid.nullable().optional(), scheduleId: zUuid.nullable().optional(), jobTitle: z.string().optional(),
      devicePin: z.string().regex(/^\d{1,12}$/).nullable().optional(), basicSalary: zMoney.optional(), bankAccount: z.string().nullable().optional(), endDate: zDate.optional(), userId: zUuid.nullable().optional() }), req.body);
    if ((b.basicSalary !== undefined || b.bankAccount !== undefined) && !req.user!.permissions.has("hr.salaries.view")) throw E.forbidden("hr.salaries.view");
    return tdb(req, async (db) => {
      const before = (await db.query("SELECT * FROM employees WHERE id = $1", [id])).rows[0];
      if (!before) throw E.notFound("employee");
      const r = (await db.query(`UPDATE employees SET full_name = coalesce($2, full_name), department_id = CASE WHEN $3 THEN $4::uuid ELSE department_id END,
          schedule_id = CASE WHEN $5 THEN $6::uuid ELSE schedule_id END, job_title = coalesce($7, job_title), device_pin = CASE WHEN $8 THEN $9 ELSE device_pin END,
          basic_salary = coalesce($10, basic_salary), bank_account = CASE WHEN $11 THEN $12 ELSE bank_account END,
          end_date = coalesce($13, end_date), status = CASE WHEN $13::date IS NOT NULL THEN 'terminated'::employee_status ELSE status END,
          user_id = CASE WHEN $14 THEN $15::uuid ELSE user_id END WHERE id = $1 RETURNING *`,
        [id, b.fullName ?? null, b.departmentId !== undefined, b.departmentId ?? null, b.scheduleId !== undefined, b.scheduleId ?? null, b.jobTitle ?? null, b.devicePin !== undefined, b.devicePin ?? null,
         b.basicSalary ?? null, b.bankAccount !== undefined, b.bankAccount ?? null, b.endDate ?? null, b.userId !== undefined, b.userId ?? null])).rows[0];
      await audit(db, { ...ac(req), action: b.endDate ? "employee.terminated" : "employee.updated", entityType: "employee", entityId: id, before: hr.mask({ ...req.user!, permissions: new Set() }, before), after: hr.mask({ ...req.user!, permissions: new Set() }, r) });
      return hr.mask(req.user!, r);
    });
  });

  // ---------------------------------------------------------------- attendance
  app.post("/hr/punches", { schema: { ...H, summary: "Manual punch (HR), audited" }, preHandler: can("hr.attendance.manage") }, async (req, reply) => {
    const b = parse(z.object({ employeeId: zUuid, punchedAt: z.string().datetime({ offset: true }), note: z.string().min(3) }), req.body);
    return reply.code(201).send(await tdb(req, async (db) => {
      const r = (await db.query("INSERT INTO punches (tenant_id, employee_id, punched_at, source, note, created_by) VALUES ($1,$2,$3,'manual',$4,$5) RETURNING *", [req.user!.tenantId, b.employeeId, b.punchedAt, b.note, req.user!.userId])).rows[0];
      await audit(db, { ...ac(req), action: "punch.manual", entityType: "employee", entityId: b.employeeId, after: r });
      return r;
    }));
  });
  app.post("/hr/punches/:id/void", { schema: { ...H, summary: "Void a punch with a reason (never deleted)" }, preHandler: can("hr.attendance.manage") }, async (req) => {
    const { id } = parse(z.object({ id: z.coerce.number().int() }), req.params);
    const b = parse(z.object({ reason: z.string().min(3) }), req.body);
    return tdb(req, async (db) => {
      const r = (await db.query("UPDATE punches SET voided = true, void_reason = $2, voided_by = $3 WHERE id = $1 RETURNING *", [id, b.reason, req.user!.userId])).rows[0];
      if (!r) throw E.notFound("punch");
      await audit(db, { ...ac(req), action: "punch.voided", entityType: "employee", entityId: r.employee_id, after: { id, reason: b.reason } });
      return r;
    });
  });
  app.put("/hr/decisions", { schema: { ...H, summary: "HR decision on an employee-day (excuse, approve overtime, waive late/early)" }, preHandler: can("hr.attendance.manage") }, async (req) => {
    const b = parse(z.object({ employeeId: zUuid, day: zDate, decision: z.enum(["excused_paid", "excused_unpaid", "approve_overtime", "waive_late", "waive_early"]),
      minutes: z.number().int().min(0).max(1440).optional(), reason: z.string().min(3) }), req.body);
    return tdb(req, async (db) => {
      const locked = (await db.query("SELECT 1 FROM payroll_runs r JOIN employees e ON e.company_id = r.company_id WHERE e.id = $1 AND r.period = to_char($2::date, 'YYYY-MM') AND r.status <> 'draft'", [b.employeeId, b.day])).rowCount;
      if (locked) throw E.rule("PAYROLL_LOCKED", "شهر هذا اليوم مقفل بمسير رواتب معتمد", "That month's payroll is approved and locked");
      const r = (await db.query(`INSERT INTO attendance_decisions (tenant_id, employee_id, day, decision, minutes, reason, decided_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (employee_id, day, decision) DO UPDATE SET minutes = EXCLUDED.minutes, reason = EXCLUDED.reason, decided_by = EXCLUDED.decided_by RETURNING *`,
        [req.user!.tenantId, b.employeeId, b.day, b.decision, b.minutes ?? null, b.reason, req.user!.userId])).rows[0];
      await audit(db, { ...ac(req), action: "attendance.decision", entityType: "employee", entityId: b.employeeId, after: r });
      return r;
    });
  });
  app.get("/hr/employees/:id/attendance", { schema: { ...H, summary: "Monthly attendance of an employee (computed with the company rules)" }, preHandler: can("hr.attendance.view") }, async (req) => {
    const { id } = parse(id$, req.params);
    const q = parse(z.object({ period: zPeriod }), req.query);
    return tdb(req, async (db) => {
      const e = (await db.query("SELECT *, hire_date::text AS hire_date, end_date::text AS end_date FROM employees WHERE id = $1", [id])).rows[0];
      if (!e) throw E.notFound("employee");
      const r = await hr.attendanceMonth(db, e, q.period, await hr.settingsOf(db, req.user!, e.company_id));
      return { employee: { id: e.id, code: e.code, full_name: e.full_name }, schedule: r.schedule, days: r.days };
    });
  });
  app.get("/hr/unmatched-punches", { schema: { ...H, summary: "Device punches whose badge number matches no employee" }, preHandler: can("hr.attendance.manage") }, async (req) =>
    tdb(req, async (db) => (await db.query("SELECT u.*, d.serial_number, d.name FROM unmatched_punches u JOIN attendance_devices d ON d.id = u.device_id ORDER BY u.punched_at DESC LIMIT 500")).rows));

  // ---------------------------------------------------------------- leave
  app.get("/hr/leave-requests", { schema: { ...H, summary: "Leave requests" }, preHandler: can("hr.employees.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid, status: z.enum(["submitted", "approved", "rejected"]).optional() }), req.query);
    return tdb(req, async (db) => (await db.query(`SELECT r.*, e.code, e.full_name, t.name_ar AS leave_type, t.paid FROM leave_requests r JOIN employees e ON e.id = r.employee_id
       JOIN leave_types t ON t.id = r.leave_type_id WHERE e.company_id = $1 AND ($2::request_status IS NULL OR r.status = $2) ORDER BY r.from_date DESC LIMIT 500`, [q.companyId, q.status ?? null])).rows);
  });
  app.post("/hr/leave-requests", { schema: { ...H, summary: "Record a leave request on behalf of an employee" }, preHandler: can("hr.employees.manage") }, async (req, reply) => {
    const b = parse(z.object({ employeeId: zUuid, leaveTypeId: zUuid, fromDate: zDate, toDate: zDate, reason: z.string().optional() }), req.body);
    return reply.code(201).send(await tdb(req, async (db) => (await db.query(`INSERT INTO leave_requests (tenant_id, employee_id, leave_type_id, from_date, to_date, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user!.tenantId, b.employeeId, b.leaveTypeId, b.fromDate, b.toDate, b.reason ?? null, req.user!.userId])).rows[0]));
  });
  for (const [path, ok] of [["approve", true], ["reject", false]] as const)
    app.post(`/hr/leave-requests/:id/${path}`, { schema: { ...H, summary: `${path} leave (balance checked; not your own)` }, preHandler: can("hr.leave.approve") }, async (req) => {
      const { id } = parse(id$, req.params);
      return tdb(req, (db) => hr.decideLeave(db, req.user!, id, ok));
    });

  // ---------------------------------------------------------------- loans & payroll
  app.post("/payroll/loans", { schema: { ...P, summary: "Give an advance/loan (Dr employee advances / Cr cash or bank)" }, preHandler: can("payroll.loans.manage") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, employeeId: zUuid, loanDate: zDate, amount: zMoney.refine((s) => Number(s) > 0), installment: zMoney.refine((s) => Number(s) > 0), method: z.enum(["cash", "bank"]) }), req.body);
    if (Number(b.installment) > Number(b.amount)) throw E.validation([{ path: "installment", message: "installment cannot exceed the amount" }]);
    return reply.code(201).send(await tdb(req, (db) => hr.createLoan(db, req.user!, b)));
  });
  app.get("/payroll/loans", { schema: { ...P, summary: "Loans and their recovery" }, preHandler: can("payroll.loans.manage") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid }), req.query);
    return tdb(req, async (db) => (await db.query("SELECT l.*, e.code, e.full_name FROM employee_loans l JOIN employees e ON e.id = l.employee_id WHERE l.company_id = $1 ORDER BY l.loan_date DESC", [q.companyId])).rows);
  });
  app.get("/payroll/runs", { schema: { ...P, summary: "Payroll runs" }, preHandler: can("payroll.runs.prepare") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid }), req.query);
    return tdb(req, async (db) => (await db.query("SELECT r.*, (SELECT count(*) FROM payroll_lines l WHERE l.run_id = r.id) AS employees FROM payroll_runs r WHERE company_id = $1 ORDER BY period DESC", [q.companyId])).rows);
  });
  app.get("/payroll/runs/:id", { schema: { ...P, summary: "Payroll run (amounts masked without hr.salaries.view)" }, preHandler: can("payroll.runs.prepare") }, async (req) => {
    const { id } = parse(id$, req.params);
    return tdb(req, (db) => hr.getPayroll(db, req.user!, id));
  });
  app.post("/payroll/runs", { schema: { ...P, summary: "Prepare (or recalculate) the payroll of a month from attendance" }, preHandler: can("payroll.runs.prepare") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, period: zPeriod }), req.body);
    return reply.code(201).send(await tdb(req, (db) => hr.preparePayroll(db, req.user!, b)));
  });
  app.post("/payroll/runs/:id/approve", { schema: { ...P, summary: "Approve & post payroll (SoD: not the preparer)" }, preHandler: can("payroll.runs.approve") }, async (req) => {
    const { id } = parse(id$, req.params);
    return tdb(req, (db) => hr.approvePayroll(db, req.user!, id));
  });
  app.post("/payroll/runs/:id/pay", { schema: { ...P, summary: "Pay salaries (Dr salaries payable / Cr bank or cash)" }, preHandler: can("payroll.runs.pay") }, async (req) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ method: z.enum(["bank", "cash"]), date: zDate }), req.body);
    return tdb(req, (db) => hr.payPayroll(db, req.user!, id, b.method, b.date));
  });
  app.get("/payroll/runs/:id/payslips/:employeeId", { schema: { ...P, summary: "Payslip" }, preHandler: can("hr.salaries.view") }, async (req) => {
    const p = parse(z.object({ id: zUuid, employeeId: zUuid }), req.params);
    return tdb(req, (db) => hr.payslip(db, p.id, p.employeeId));
  });

  // ---------------------------------------------------------------- self-service (own data only)
  const me = async (db: any, req: any) => {
    const e = (await db.query("SELECT *, hire_date::text AS hire_date, end_date::text AS end_date FROM employees WHERE user_id = $1", [req.user.userId])).rows[0];
    if (!e) throw E.rule("NOT_AN_EMPLOYEE", "حسابك غير مرتبط بملف موظف", "Your account is not linked to an employee record");
    return e;
  };
  app.get("/hr/me", { schema: { ...S, summary: "My profile, leave balance usage, recent payslips" }, preHandler: can("hr.self.view") }, async (req) =>
    tdb(req, async (db) => {
      const e = await me(db, req);
      const payslips = (await db.query("SELECT r.id AS run_id, r.period, r.status, l.net FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id WHERE l.employee_id = $1 AND r.status <> 'draft' ORDER BY r.period DESC LIMIT 12", [e.id])).rows;
      const leaves = (await db.query(`SELECT r.*, t.name_ar AS leave_type FROM leave_requests r JOIN leave_types t ON t.id = r.leave_type_id WHERE r.employee_id = $1 ORDER BY r.from_date DESC LIMIT 20`, [e.id])).rows;
      const types = (await db.query("SELECT id, name_ar, paid, annual_days FROM leave_types WHERE company_id = $1 ORDER BY code", [e.company_id])).rows;
      return { employee: { id: e.id, code: e.code, full_name: e.full_name, job_title: e.job_title, hire_date: e.hire_date }, payslips, leaves, leaveTypes: types,
        appPunch: (await hr.settingsOf(db, req.user!, e.company_id)).app_punch_enabled };
    }));
  app.get("/hr/me/attendance", { schema: { ...S, summary: "My month" }, preHandler: can("hr.self.view") }, async (req) => {
    const q = parse(z.object({ period: zPeriod }), req.query);
    return tdb(req, async (db) => { const e = await me(db, req); return (await hr.attendanceMonth(db, e, q.period, await hr.settingsOf(db, req.user!, e.company_id))).days; });
  });
  app.get("/hr/me/payslips/:runId", { schema: { ...S, summary: "My payslip (approved payrolls only)" }, preHandler: can("hr.self.view") }, async (req) => {
    const { runId } = parse(z.object({ runId: zUuid }), req.params);
    return tdb(req, async (db) => {
      const e = await me(db, req);
      const run = (await db.query("SELECT status FROM payroll_runs WHERE id = $1", [runId])).rows[0];
      if (!run || run.status === "draft") throw E.notFound("payslip");
      return hr.payslip(db, runId, e.id);
    });
  });
  app.post("/hr/me/leave", { schema: { ...S, summary: "Request leave" }, preHandler: can("hr.self.request") }, async (req, reply) => {
    const b = parse(z.object({ leaveTypeId: zUuid, fromDate: zDate, toDate: zDate, reason: z.string().max(500).optional() }), req.body);
    return reply.code(201).send(await tdb(req, async (db) => {
      const e = await me(db, req);
      return (await db.query("INSERT INTO leave_requests (tenant_id, employee_id, leave_type_id, from_date, to_date, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
        [req.user!.tenantId, e.id, b.leaveTypeId, b.fromDate, b.toDate, b.reason ?? null, req.user!.userId])).rows[0];
    }));
  });
  app.post("/hr/me/punch", { schema: { ...S, summary: "Punch from the app (when the company enables it)" }, preHandler: can("hr.self.request") }, async (req, reply) => {
    const b = parse(z.object({ lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional() }), req.body ?? {});
    return reply.code(201).send(await tdb(req, async (db) => {
      const e = await me(db, req);
      if (!(await hr.settingsOf(db, req.user!, e.company_id)).app_punch_enabled) throw E.rule("APP_PUNCH_DISABLED", "التسجيل من التطبيق غير مفعّل في الشركة", "App punch is disabled by the company");
      return (await db.query("INSERT INTO punches (tenant_id, employee_id, punched_at, source, lat, lng, created_by) VALUES ($1,$2,now(),'app',$3,$4,$5) RETURNING *",
        [req.user!.tenantId, e.id, b.lat ?? null, b.lng ?? null, req.user!.userId])).rows[0];
    }));
  });
}

/** ZKTeco iclock/ADMS push protocol — devices cannot authenticate, so the serial number must be registered */
export async function iclockRoutes(app: FastifyInstance) {
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => done(null, body));
  const device = async (sn: unknown) => {
    if (typeof sn !== "string" || !/^[A-Za-z0-9_-]{4,40}$/.test(sn)) return null;
    const d = await withAnonymous(async (db) => (await db.query("SELECT * FROM device_by_serial($1)", [sn])).rows[0]);
    return d?.is_active ? d : null;
  };
  app.get("/iclock/cdata", { schema: { hide: true } }, async (req, reply) => {
    const q = req.query as any;
    const d = await device(q.SN);
    if (!d) return reply.code(404).type("text/plain").send("UNKNOWN");
    return reply.type("text/plain").send(`GET OPTION FROM: ${q.SN}\nATTLOGStamp=None\nOPERLOGStamp=9999\nErrorDelay=60\nDelay=30\nTransTimes=00:00;14:05\nTransInterval=1\nTransFlag=1000000000\nRealtime=1\nEncrypt=0\n`);
  });
  app.post("/iclock/cdata", { schema: { hide: true } }, async (req, reply) => {
    const q = req.query as any;
    const d = await device(q.SN);
    if (!d) return reply.code(404).type("text/plain").send("UNKNOWN");
    if (String(q.table ?? "").toUpperCase() !== "ATTLOG") return reply.type("text/plain").send("OK");
    const r = await withTenant(d.tenant_id, null, (db) => hr.ingestAttlog(db, d, String(req.body ?? "")));
    return reply.type("text/plain").send(`OK: ${r.stored}`);
  });
  app.get("/iclock/getrequest", { schema: { hide: true } }, async (req, reply) => {
    const d = await device((req.query as any).SN);
    return reply.code(d ? 200 : 404).type("text/plain").send(d ? "OK" : "UNKNOWN");
  });
}
