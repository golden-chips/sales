import { describe, it, expect, beforeAll } from "vitest";
import { api, platformToken, createPlan, provision, roleId, createUser, getApp } from "./helpers.js";
import { withTenant } from "../src/db/pool.js";

const Y = new Date().getUTCFullYear();
const P = `${Y}-03`;
const march = Array.from({ length: 31 }, (_, i) => `${P}-${String(i + 1).padStart(2, "0")}`);
const workdays = march.filter((d) => new Date(`${d}T12:00:00Z`).getUTCDay() !== 5);   // Friday weekend
const W = workdays.length;

describe("HR & payroll: device punches → attendance → leave → loan → payroll → GL → self-service", () => {
  let T: any, HRM: any, FIN: any, EMP: any, BM: any, e1: any, e2: any, run: any, annual: any;
  const ok = (r: any, s = 201) => { if (r.status !== s) throw new Error(`${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  const as = (u: any) => ({ token: u.token });
  const gl = async (code: string) => (await api("GET", `/api/v1/accounting/reports/trial-balance?companyId=${T.companyId}&from=${Y}-01-01&to=${Y}-12-31`, undefined, as(T))).body.rows.find((r: any) => r.code === code)?.closing ?? "0";
  const iclock = async (method: "GET" | "POST", sn: string, body?: string, table = "ATTLOG") => {
    const app = await getApp();
    return app.inject({ method, url: `/iclock/cdata?SN=${sn}${method === "POST" ? `&table=${table}` : "&options=all"}`, payload: body, headers: { "content-type": "text/plain" } });
  };

  beforeAll(async () => {
    const p = await platformToken();
    const plan = await createPlan(p, { modules: ["accounting", "hr", "payroll"], maxUsers: 20 });
    T = await provision(p, plan.code);
    ok(await api("POST", "/api/v1/accounting/accounts/seed-template", { companyId: T.companyId }, as(T)));
    ok(await api("POST", "/api/v1/accounting/fiscal-years", { companyId: T.companyId, name: `FY${Y}`, startDate: `${Y}-01-01` }, as(T)));
    HRM = await createUser(T, [{ roleId: await roleId(T.token, "hr_manager") }]);
    FIN = await createUser(T, [{ roleId: await roleId(T.token, "finance_manager") }]);
    EMP = await createUser(T, [{ roleId: await roleId(T.token, "employee") }]);
    BM = await createUser(T, [{ roleId: await roleId(T.token, "branch_manager") }]);
    const c = T.companyId;
    const adm = ok(await api("POST", "/api/v1/hr/departments", { companyId: c, code: "ADM", nameAr: "الإدارة" }, as(HRM)));
    const prod = ok(await api("POST", "/api/v1/hr/departments", { companyId: c, code: "PROD", nameAr: "الإنتاج", expenseRole: "direct_labour" }, as(HRM)));
    const sch = ok(await api("POST", "/api/v1/hr/schedules", { companyId: c, code: "DAY", nameAr: "صباحي", start: "08:00", end: "16:00" }, as(HRM)));
    annual = ok(await api("POST", "/api/v1/hr/leave-types", { companyId: c, code: "ANNUAL", nameAr: "سنوية", paid: true, annualDays: "21" }, as(HRM)));
    // statutory deduction defined BY THE COMPANY (rate is a test value, not an assumed legal rate)
    ok(await api("POST", "/api/v1/payroll/components", { companyId: c, code: "SOC", nameAr: "استقطاع (قيمة اختبار)", kind: "deduction", method: "percent_of_basic", defaultValue: "3.75", appliesToAll: true }, as(HRM)));
    const house = ok(await api("POST", "/api/v1/payroll/components", { companyId: c, code: "HOUSE", nameAr: "بدل سكن", kind: "earning", method: "fixed", defaultValue: "150" }, as(HRM)));
    ok(await api("POST", "/api/v1/hr/devices", { companyId: c, serialNumber: "GC-TEST-001", name: "بصمة المصنع" }, as(HRM)));
    e1 = ok(await api("POST", "/api/v1/hr/employees", { companyId: c, code: "E1", fullName: "موظف إداري", departmentId: adm.id, scheduleId: sch.id, hireDate: `${Y - 1}-01-01`,
      basicSalary: "1350", devicePin: "101", userId: EMP.id, components: [{ componentId: house.id, value: "150" }] }, as(HRM)));
    e2 = ok(await api("POST", "/api/v1/hr/employees", { companyId: c, code: "E2", fullName: "عامل إنتاج", departmentId: prod.id, scheduleId: sch.id, hireDate: `${Y - 1}-01-01`, basicSalary: "2700", devicePin: "102" }, as(HRM)));
  });

  it("fingerprint device: unknown serial rejected; ATTLOG lines stored once; unknown badges kept aside", async () => {
    expect((await iclock("GET", "NOPE-0000")).statusCode).toBe(404);
    expect((await iclock("GET", "GC-TEST-001")).body).toMatch(/^GET OPTION FROM: GC-TEST-001/);
    const lines: string[] = [];
    for (const d of workdays) {
      if (d !== `${P}-02`) lines.push(`101\t${d} ${["03", "04", "05"].includes(d.slice(8)) && d !== `${P}-02` ? "08:30" : "07:58"}:00\t0\t1`, `101\t${d} 16:01:00\t1\t1`);
      lines.push(`102\t${d} 07:55:00\t0\t1`, `102\t${d} ${d === `${P}-10` ? "18:00" : "16:00"}:00\t1\t1`);
    }
    lines.push(`999\t${P}-10 08:00:00\t0\t1`);
    const r1 = await iclock("POST", "GC-TEST-001", lines.join("\n"));
    expect(r1.body).toBe(`OK: ${lines.length - 1}`);
    expect((await iclock("POST", "GC-TEST-001", lines.join("\n"))).body).toBe("OK: 0");   // device re-sends → no duplicates
    expect(ok(await api("GET", "/api/v1/hr/unmatched-punches", undefined, as(HRM)), 200)).toHaveLength(1);
  });

  it("attendance computed with حضوري rules (Friday weekend, absence, late after grace)", async () => {
    const days = ok(await api("GET", `/api/v1/hr/employees/${e1.id}/attendance?period=${P}`, undefined, as(HRM)), 200).days;
    const by = Object.fromEntries(days.map((d: any) => [d.date, d]));
    expect(by[`${P}-02`].status).toBe("absent");
    const lateDays = days.filter((d: any) => d.lateMin > 0).map((d: any) => d.lateMin);
    expect(lateDays.every((m: number) => m === 30)).toBe(true);
    expect(days.filter((d: any) => !d.workDay).every((d: any) => d.status === "off")).toBe(true);
  });

  it("salary is a sensitive field: masked for viewers without hr.salaries.view", async () => {
    const list = ok(await api("GET", `/api/v1/hr/employees?companyId=${T.companyId}`, undefined, as(BM)), 200);
    expect(list[0]).toMatchObject({ basic_salary: null, bank_account: null, masked: true });
    const full = ok(await api("GET", `/api/v1/hr/employees?companyId=${T.companyId}`, undefined, as(FIN)), 200);
    expect(full.find((e: any) => e.code === "E1").basic_salary).toBe("1350.0000");
  });

  it("overtime only after an HR approval; punches are voided, never deleted", async () => {
    ok(await api("PUT", "/api/v1/hr/decisions", { employeeId: e2.id, day: `${P}-10`, decision: "approve_overtime", reason: "طلبية عاجلة" }, as(HRM)), 200);
    const m = await api("POST", "/api/v1/hr/punches", { employeeId: e1.id, punchedAt: `${Y}-04-01T07:00:00Z`, note: "نسي البصمة" }, as(HRM));
    const pid = ok(m).id;
    ok(await api("POST", `/api/v1/hr/punches/${pid}/void`, { reason: "أُدخلت خطأ" }, as(HRM)), 200);
    await expect(withTenant(T.tenantId, null, (db) => db.query("DELETE FROM punches WHERE id = $1", [pid]))).rejects.toThrow();
    await expect(withTenant(T.tenantId, null, (db) => db.query("UPDATE punches SET voided = false WHERE id = $1", [pid]))).rejects.toThrow(/immutable/);
  });

  it("leave: employee requests via self-service; cannot approve own; balance enforced", async () => {
    const mine = ok(await api("POST", "/api/v1/hr/me/leave", { leaveTypeId: annual.id, fromDate: `${Y}-04-06`, toDate: `${Y}-04-07` }, as(EMP)));
    expect((await api("POST", `/api/v1/hr/leave-requests/${mine.id}/approve`, {}, as(EMP))).status).toBe(403);
    ok(await api("POST", `/api/v1/hr/leave-requests/${mine.id}/approve`, {}, as(HRM)), 200);
    const big = ok(await api("POST", "/api/v1/hr/me/leave", { leaveTypeId: annual.id, fromDate: `${Y}-05-01`, toDate: `${Y}-05-25` }, as(EMP)));
    expect((await api("POST", `/api/v1/hr/leave-requests/${big.id}/approve`, {}, as(HRM))).body.error.code).toBe("LEAVE_BALANCE_EXCEEDED");
  });

  it("loan: Dr employee advances / Cr cash", async () => {
    ok(await api("POST", "/api/v1/payroll/loans", { companyId: T.companyId, employeeId: e1.id, loanDate: `${P}-01`, amount: "300", installment: "100", method: "cash" }, as(FIN)));
    expect(await gl("1132")).toBe("300.0000");
  });

  it("payroll: computed from attendance; approval by someone else posts the journal per department", async () => {
    run = ok(await api("POST", "/api/v1/payroll/runs", { companyId: T.companyId, period: P }, as(HRM)));
    const l1 = run.lines.find((l: any) => l.code === "E1");
    const daily = 1350 / W, minute = daily / 480;
    const lateCharged = 30 * Math.max(0, 3 - 2);   // 3 late days, first 2 of the month free
    expect([l1.work_days, l1.absent_days, l1.late_minutes]).toEqual([W, "1.00", lateCharged]);
    expect(Number(l1.absence_deduction)).toBeCloseTo(daily, 3);
    expect(Number(l1.late_deduction)).toBeCloseTo(minute * lateCharged, 3);
    expect([l1.earnings_components, l1.statutory_deductions, l1.loan_recovery]).toEqual(["150.0000", "50.6250", "100.0000"]);
    const earned1 = Number(l1.earned);
    expect(earned1).toBeCloseTo(1350 + 150 - daily - minute * lateCharged, 2);
    expect(Number(l1.net)).toBeCloseTo(earned1 - 50.625 - 100, 3);
    const l2 = run.lines.find((l: any) => l.code === "E2");
    expect([l2.overtime_minutes, Number(l2.overtime_pay)]).toEqual([120, Number(((2700 / W / 480) * 120 * 1.5).toFixed(3))]);
    expect((await api("POST", `/api/v1/payroll/runs/${run.id}/approve`, {}, as(HRM))).body.error.code).toBe("SEGREGATION_OF_DUTIES");
    ok(await api("POST", `/api/v1/payroll/runs/${run.id}/approve`, {}, as(FIN)), 200);
    expect(await gl("5401")).toBe(l1.earned);              // admin salaries
    expect(await gl("5201")).toBe(l2.earned);              // production → direct labour
    expect(Number(await gl("2103"))).toBeCloseTo(-(Number(l1.net) + Number(l2.net)), 3);
    expect(Number(await gl("2104"))).toBeCloseTo(-(50.625 + 101.25), 3);
    expect(await gl("1132")).toBe("200.0000");             // 300 loan − 100 recovered
    const loans = ok(await api("GET", `/api/v1/payroll/loans?companyId=${T.companyId}`, undefined, as(FIN)), 200);
    expect(loans[0].recovered).toBe("100.0000");
  });

  it("an approved month is locked: no recalculation, no attendance decisions", async () => {
    expect((await api("POST", "/api/v1/payroll/runs", { companyId: T.companyId, period: P }, as(HRM))).body.error.code).toBe("PAYROLL_LOCKED");
    expect((await api("PUT", "/api/v1/hr/decisions", { employeeId: e1.id, day: `${P}-02`, decision: "excused_paid", reason: "متأخر" }, as(HRM))).body.error.code).toBe("PAYROLL_LOCKED");
    await expect(withTenant(T.tenantId, null, (db) => db.query("UPDATE payroll_lines SET net = 0 WHERE run_id = $1", [run.id]))).rejects.toThrow(/frozen/);
  });

  it("payment clears salaries payable; employee sees own payslip only", async () => {
    ok(await api("POST", `/api/v1/payroll/runs/${run.id}/pay`, { method: "bank", date: `${Y}-04-02` }, as(FIN)), 200);
    expect(Number(await gl("2103"))).toBe(0);
    const me = ok(await api("GET", "/api/v1/hr/me", undefined, as(EMP)), 200);
    expect(me.payslips.map((p: any) => p.period)).toEqual([P]);
    const slip = ok(await api("GET", `/api/v1/hr/me/payslips/${run.id}`, undefined, as(EMP)), 200);
    expect([slip.code, slip.items.map((i: any) => i.code).sort()]).toEqual(["E1", ["HOUSE", "SOC"]]);
    expect((await api("GET", `/api/v1/payroll/runs/${run.id}/payslips/${e2.id}`, undefined, as(EMP))).status).toBe(403);
    expect((await api("GET", `/api/v1/accounting/reports/trial-balance?companyId=${T.companyId}&from=${Y}-01-01&to=${Y}-12-31`, undefined, as(T))).body.totals.balanced).toBe(true);
  });

  it("subledgers agree with the GL after the whole scenario (go-live reconciliation)", async () => {
    const r = (await api("GET", `/api/v1/go-live/reconciliation?companyId=${T.companyId}&asOf=${Number(Y) + 1}-12-31`, undefined, { token: T.token })).body;
    expect(r.rows.filter((x: any) => !x.ok)).toEqual([]);
  });
});
