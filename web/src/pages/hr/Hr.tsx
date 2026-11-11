import { useState } from "react";
import { api, fmt, fmtDate } from "../../api";
import { useI18n } from "../../i18n";
import { useSession } from "../../session";
import { Empty, ErrorBox, Field, Loading, Modal, errMsg, useAsync, useToast } from "../../ui";
import { LinesTable, today } from "../erp/shared";

const thisMonth = () => today().slice(0, 7);
const STATUS_AR: Record<string, [string, string]> = {
  present: ["حاضر", "ok"], absent: ["غائب", "bad"], off: ["عطلة أسبوعية", ""], holiday: ["عطلة رسمية", ""], leave_paid: ["إجازة", "info"], leave_unpaid: ["إجازة بدون راتب", "warn"],
  excused_paid: ["غياب بعذر", "info"], excused_unpaid: ["غياب بعذر (بلا راتب)", "warn"], not_employed: ["خارج الخدمة", ""],
};
const hm = (m: number | null) => (m === null ? "—" : `${String(Math.floor((((m % 1440) + 1440) % 1440) / 60)).padStart(2, "0")}:${String((((m % 1440) + 1440) % 1440) % 60).padStart(2, "0")}`);

export function Employees() {
  const { t, tt } = useI18n();
  const { can, companyId } = useSession();
  const { toast } = useToast();
  const list = useAsync(() => api.get(`/hr/employees?companyId=${companyId}`), [companyId]);
  const deps = useAsync(() => api.get(`/hr/departments?companyId=${companyId}`), [companyId]);
  const schs = useAsync(() => api.get(`/hr/schedules?companyId=${companyId}`), [companyId]);
  const [f, setF] = useState<any | null>(null);
  const [att, setAtt] = useState<any | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const salaries = can("hr.salaries.view");
  const save = async () => {
    setErr(null);
    try { await api.post("/hr/employees", { companyId, ...f, departmentId: f.departmentId || null, scheduleId: f.scheduleId || null, devicePin: f.devicePin || undefined, basicSalary: f.basicSalary || "0" }); setF(null); list.reload(); toast(t.savedOk); }
    catch (e) { setErr(e); }
  };
  return <>
    <div className="page-head"><h1>{tt("الموظفون", "Employees")}</h1>{can("hr.employees.manage") && <button className="btn primary" onClick={() => setF({ hireDate: today() })}>{t.add}</button>}</div>
    <ErrorBox error={list.error} />
    {list.loading ? <Loading /> : !list.data?.length ? <div className="card"><Empty /></div> : <div className="table-wrap"><table>
      <thead><tr><th>{t.code}</th><th>{t.name}</th><th>{tt("القسم", "Department")}</th><th>{tt("الوظيفة", "Job")}</th><th>{tt("الدوام", "Schedule")}</th><th>{tt("رقم البصمة", "Badge")}</th>
        <th className="end">{tt("الراتب الأساسي", "Basic salary")}</th><th>{t.status}</th><th /></tr></thead>
      <tbody>{list.data.map((e: any) => <tr key={e.id}><td className="num">{e.code}</td><td>{e.full_name}</td><td>{e.department}</td><td>{e.job_title}</td><td>{e.schedule_code}</td><td className="num">{e.device_pin}</td>
        <td className="end num">{e.masked ? <span className="badge" title={tt("حقل حساس", "Sensitive field")}>🔒</span> : fmt(e.basic_salary)}</td>
        <td><span className={`badge ${e.status === "active" ? "ok" : "bad"}`}>{e.status === "active" ? t.active : tt("منتهي", "Terminated")}</span></td>
        <td>{can("hr.attendance.view") && <button className="btn sm" onClick={() => setAtt(e)}>{tt("الحضور", "Attendance")}</button>}</td></tr>)}</tbody>
    </table></div>}
    {att && <AttendanceModal emp={att} onClose={() => setAtt(null)} />}
    {f && <Modal title={tt("موظف جديد", "New employee")} onClose={() => setF(null)} footer={<><button className="btn" onClick={() => setF(null)}>{t.cancel}</button><button className="btn primary" onClick={save}>{t.save}</button></>}>
      <ErrorBox error={err} />
      <div className="form-grid">
        <Field label={t.code}><input dir="ltr" value={f.code ?? ""} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
        <Field label={t.fullName}><input value={f.fullName ?? ""} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></Field>
        <Field label={tt("القسم", "Department")}><select value={f.departmentId ?? ""} onChange={(e) => setF({ ...f, departmentId: e.target.value })}><option value="">—</option>{deps.data?.map((d: any) => <option key={d.id} value={d.id}>{d.name_ar}</option>)}</select></Field>
        <Field label={tt("الدوام", "Schedule")}><select value={f.scheduleId ?? ""} onChange={(e) => setF({ ...f, scheduleId: e.target.value })}><option value="">—</option>{schs.data?.map((s: any) => <option key={s.id} value={s.id}>{s.name_ar} {String(s.start_time).slice(0, 5)}–{String(s.end_time).slice(0, 5)}</option>)}</select></Field>
        <Field label={tt("الوظيفة", "Job title")}><input value={f.jobTitle ?? ""} onChange={(e) => setF({ ...f, jobTitle: e.target.value })} /></Field>
        <Field label={tt("تاريخ التعيين", "Hire date")}><input type="date" value={f.hireDate} onChange={(e) => setF({ ...f, hireDate: e.target.value })} /></Field>
        <Field label={tt("رقم البصمة على الجهاز", "Device badge no.")}><input dir="ltr" inputMode="numeric" value={f.devicePin ?? ""} onChange={(e) => setF({ ...f, devicePin: e.target.value })} /></Field>
        {salaries && <Field label={tt("الراتب الأساسي", "Basic salary")}><input className="num" value={f.basicSalary ?? ""} onChange={(e) => setF({ ...f, basicSalary: e.target.value })} /></Field>}
      </div>
    </Modal>}
  </>;
}

function AttendanceModal({ emp, onClose }: { emp: any; onClose: () => void }) {
  const { tt, lang } = useI18n();
  const { can } = useSession();
  const { toast } = useToast();
  const [period, setPeriod] = useState(thisMonth());
  const d = useAsync(() => api.get(`/hr/employees/${emp.id}/attendance?period=${period}`), [emp.id, period]);
  const decide = async (day: string, decision: string) => {
    const reason = prompt(tt("السبب", "Reason")); if (!reason) return;
    try { await api.put("/hr/decisions", { employeeId: emp.id, day, decision, reason }); d.reload(); } catch (e) { toast(errMsg(e, lang), true); }
  };
  const days = d.data?.days ?? [];
  const sum = (k: string) => days.reduce((a: number, x: any) => a + (x[k] || 0), 0);
  return <Modal title={`${emp.code} — ${emp.full_name}`} onClose={onClose}>
    <div className="row" style={{ marginBottom: 12 }}><input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} style={{ width: "auto" }} />
      <span className="badge bad">{tt("غياب", "Absent")} {days.filter((x: any) => x.status === "absent").length}</span><span className="badge warn">{tt("تأخير", "Late")} {sum("lateMin")} {tt("د", "min")}</span>
      <span className="badge">{tt("خروج مبكر", "Early")} {sum("earlyMin")} {tt("د", "min")}</span><span className="badge info">{tt("إضافي", "Overtime")} {sum("overtimeMin")} {tt("د", "min")}</span></div>
    {d.loading ? <Loading /> : <LinesTable rows={days} cols={[{ h: tt("اليوم", "Day"), v: (x) => fmtDate(x.date) }, { h: tt("الحالة", "Status"), v: (x) => <span className={`badge ${STATUS_AR[x.status]?.[1] ?? ""}`}>{lang === "ar" ? STATUS_AR[x.status]?.[0] ?? x.status : x.status}</span> },
      { h: tt("دخول", "In"), v: (x) => <span className="num">{hm(x.inMin)}</span> }, { h: tt("خروج", "Out"), v: (x) => <span className="num">{x.missingOut ? <span className="badge warn">?</span> : hm(x.outMin)}</span> },
      { h: tt("تأخير", "Late"), v: (x) => x.lateMin || "" }, { h: tt("مبكر", "Early"), v: (x) => x.earlyMin || "" }, { h: tt("إضافي", "OT"), v: (x) => x.overtimeMin || "" },
      { h: "", v: (x) => can("hr.attendance.manage") && <span className="row">
        {x.status === "absent" && <button className="btn sm" onClick={() => decide(x.date, "excused_paid")}>{tt("عذر", "Excuse")}</button>}
        {x.lateMin > 0 && <button className="btn sm" onClick={() => decide(x.date, "waive_late")}>{tt("إعفاء", "Waive")}</button>}
        {x.outMin !== null && <button className="btn sm" onClick={() => decide(x.date, "approve_overtime")}>{tt("اعتماد إضافي", "Approve OT")}</button>}</span> }]} />}
  </Modal>;
}

export function Leaves() {
  const { t, tt, lang } = useI18n();
  const { can, companyId } = useSession();
  const { toast } = useToast();
  const [status, setStatus] = useState("submitted");
  const list = useAsync(() => api.get(`/hr/leave-requests?companyId=${companyId}${status ? `&status=${status}` : ""}`), [companyId, status]);
  const act = async (id: string, a: "approve" | "reject") => { try { await api.post(`/hr/leave-requests/${id}/${a}`); list.reload(); toast(t.savedOk); } catch (e) { toast(errMsg(e, lang), true); } };
  return <>
    <div className="page-head"><h1>{tt("الإجازات", "Leave")}</h1><select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: "auto" }}>
      <option value="submitted">{tt("بانتظار الاعتماد", "Pending")}</option><option value="approved">{tt("معتمدة", "Approved")}</option><option value="">*</option></select></div>
    <ErrorBox error={list.error} />
    {!list.data?.length ? <div className="card"><Empty /></div> : <LinesTable rows={list.data} cols={[{ h: tt("الموظف", "Employee"), v: (r) => `${r.code} ${r.full_name}` }, { h: tt("النوع", "Type"), v: (r) => r.leave_type },
      { h: t.from, v: (r) => fmtDate(r.from_date) }, { h: t.to, v: (r) => fmtDate(r.to_date) }, { h: t.reason, v: (r) => r.reason ?? "" }, { h: t.status, v: (r) => r.status },
      { h: "", v: (r) => r.status === "submitted" && can("hr.leave.approve") && <span className="row"><button className="btn sm primary" onClick={() => act(r.id, "approve")}>{tt("اعتماد", "Approve")}</button>
        <button className="btn sm" onClick={() => act(r.id, "reject")}>{tt("رفض", "Reject")}</button></span> }]} />}
  </>;
}

export function Payroll() {
  const { t, tt, lang } = useI18n();
  const { can, companyId } = useSession();
  const { toast } = useToast();
  const [period, setPeriod] = useState(thisMonth());
  const [open, setOpen] = useState<string | null>(null);
  const runs = useAsync(() => api.get(`/payroll/runs?companyId=${companyId}`), [companyId]);
  const run = useAsync(() => (open ? api.get(`/payroll/runs/${open}`) : Promise.resolve(null)), [open]);
  const go = async (fn: () => Promise<any>) => { try { const r = await fn(); if (r?.id) setOpen(r.id); runs.reload(); run.reload(); toast(t.savedOk); } catch (e) { toast(errMsg(e, lang), true); } };
  const r = run.data;
  return <>
    <div className="page-head"><div><h1>{tt("مسير الرواتب", "Payroll")}</h1><p>{tt("يُحتسب من الحضور والإجازات وقرارات الأيام وبنود الرواتب والسلف والعجوزات. يعدّه شخص ويعتمده آخر.", "Calculated from attendance, leave, day decisions, pay components, loans and shortages. Prepared by one person, approved by another.")}</p></div>
      {can("payroll.runs.prepare") && <div className="row"><input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} style={{ width: "auto" }} />
        <button className="btn primary" onClick={() => go(() => api.post("/payroll/runs", { companyId, period }))}>{tt("احتساب / إعادة احتساب", "Calculate")}</button></div>}</div>
    {!runs.data?.length ? <div className="card"><Empty /></div> : <LinesTable rows={runs.data} cols={[{ h: tt("الشهر", "Month"), v: (x) => x.period }, { h: tt("موظفون", "Employees"), v: (x) => x.employees },
      { h: tt("صافي الرواتب", "Net"), v: (x) => fmt(x.total_net), end: true }, { h: t.status, v: (x) => x.status }, { h: "", v: (x) => <button className="btn sm" onClick={() => setOpen(x.id)}>{t.details}</button> }]} />}
    {open && <Modal title={`${tt("مسير", "Payroll")} ${r?.period ?? ""}`} onClose={() => setOpen(null)} footer={r && <>
      {r.status === "draft" && can("payroll.runs.approve") && <button className="btn primary" onClick={() => go(() => api.post(`/payroll/runs/${r.id}/approve`))}>{tt("اعتماد وترحيل", "Approve & post")}</button>}
      {r.status === "approved" && can("payroll.runs.pay") && <button className="btn primary" onClick={() => go(() => api.post(`/payroll/runs/${r.id}/pay`, { method: "bank", date: today() }))}>{tt("صرف عبر المصرف", "Pay by bank")}</button>}</>}>
      {run.loading ? <Loading /> : r && <div className="grid">
        {r.status === "draft" && <div className="alert info">{t.sodHint}</div>}
        <LinesTable rows={r.lines} cols={r.lines[0]?.masked ? [{ h: tt("الموظف", "Employee"), v: (l) => `${l.code} ${l.full_name}` }, { h: tt("أيام", "Days"), v: (l) => `${l.present_days}/${l.work_days}` },
          { h: tt("غياب", "Absent"), v: (l) => Number(l.absent_days) }, { h: tt("تأخير د", "Late min"), v: (l) => l.late_minutes }, { h: "", v: () => "🔒" }] : [
          { h: tt("الموظف", "Employee"), v: (l) => `${l.code} ${l.full_name}` }, { h: tt("أيام", "Days"), v: (l) => `${l.present_days}/${l.work_days}` }, { h: tt("الأساسي", "Basic"), v: (l) => fmt(l.basic), end: true },
          { h: tt("بدلات+إضافي", "Allow.+OT"), v: (l) => fmt(Number(l.earnings_components) + Number(l.overtime_pay)), end: true },
          { h: tt("غياب/تأخير", "Absence/late"), v: (l) => fmt(Number(l.absence_deduction) + Number(l.late_deduction) + Number(l.early_deduction)), end: true },
          { h: tt("استقطاعات", "Statutory"), v: (l) => fmt(l.statutory_deductions), end: true }, { h: tt("سلف/عجز", "Loans/shortage"), v: (l) => fmt(Number(l.loan_recovery) + Number(l.shortage_recovery)), end: true },
          { h: tt("الصافي", "Net"), v: (l) => <b>{fmt(l.net)}</b>, end: true }]} />
        <div className="balance-bar"><span>{tt("المستحق", "Earned")} <b className="num">{fmt(r.total_earned)}</b></span><span>{tt("الصافي", "Net")} <b className="num">{fmt(r.total_net)}</b></span><span className="badge">{r.status}</span></div>
      </div>}
    </Modal>}
  </>;
}

export function MyHr() {
  const { t, tt, lang } = useI18n();
  const { toast } = useToast();
  const me = useAsync(() => api.get("/hr/me"), []);
  const [period, setPeriod] = useState(thisMonth());
  const days = useAsync(() => api.get(`/hr/me/attendance?period=${period}`), [period]);
  const [slip, setSlip] = useState<any>(null);
  const [lv, setLv] = useState<any | null>(null);
  if (me.loading) return <Loading />;
  if (me.error) return <ErrorBox error={me.error} />;
  const m = me.data;
  const punch = () => {
    const send = (pos?: GeolocationPosition) => api.post("/hr/me/punch", pos ? { lat: Number(pos.coords.latitude.toFixed(6)), lng: Number(pos.coords.longitude.toFixed(6)) } : {})
      .then(() => { toast(tt("تم تسجيل البصمة", "Punch recorded")); days.reload(); }, (e) => toast(errMsg(e, lang), true));
    navigator.geolocation ? navigator.geolocation.getCurrentPosition(send, () => send(), { timeout: 5000 }) : send();
  };
  return <div className="grid" style={{ maxWidth: 760 }}>
    <div className="card row"><div><h2 style={{ margin: 0 }}>{m.employee.full_name}</h2><span style={{ color: "var(--muted)" }}>{m.employee.code} · {m.employee.job_title}</span></div><span className="spacer" />
      {m.appPunch && <button className="btn primary" onClick={punch}>{tt("تسجيل حضور/انصراف", "Punch in/out")}</button>}
      <button className="btn" onClick={() => setLv({ leaveTypeId: m.leaveTypes[0]?.id, fromDate: today(), toDate: today() })}>{tt("طلب إجازة", "Request leave")}</button></div>
    <div className="card"><div className="row"><h2 style={{ margin: 0 }}>{tt("حضوري", "My attendance")}</h2><span className="spacer" /><input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} style={{ width: "auto" }} /></div>
      {days.data && <div className="row" style={{ marginTop: 8 }}>{days.data.map((x: any) => <span key={x.date} title={`${x.date} ${STATUS_AR[x.status]?.[0] ?? x.status}${x.lateMin ? ` · ${tt("تأخير", "late")} ${x.lateMin}` : ""}`}
        className={`badge ${STATUS_AR[x.status]?.[1] ?? ""}`} style={{ minWidth: 34, textAlign: "center" }}>{x.date.slice(8)}{x.lateMin ? "⏱" : ""}</span>)}</div>}</div>
    <div className="card"><h2>{tt("قسائم راتبي", "My payslips")}</h2>
      {!m.payslips.length ? <p style={{ color: "var(--muted)" }}>{t.none}</p> : <LinesTable rows={m.payslips} cols={[{ h: tt("الشهر", "Month"), v: (p) => p.period }, { h: tt("الصافي", "Net"), v: (p) => fmt(p.net), end: true },
        { h: "", v: (p) => <button className="btn sm" onClick={async () => setSlip(await api.get(`/hr/me/payslips/${p.run_id}`))}>{t.details}</button> }]} />}</div>
    <div className="card"><h2>{tt("طلبات الإجازة", "My leave requests")}</h2>
      {!m.leaves.length ? <p style={{ color: "var(--muted)" }}>{t.none}</p> : <LinesTable rows={m.leaves} cols={[{ h: tt("النوع", "Type"), v: (r) => r.leave_type }, { h: t.from, v: (r) => fmtDate(r.from_date) }, { h: t.to, v: (r) => fmtDate(r.to_date) }, { h: t.status, v: (r) => r.status }]} />}</div>
    {slip && <Modal title={`${tt("قسيمة راتب", "Payslip")} ${slip.period}`} onClose={() => setSlip(null)}>
      <LinesTable rows={[[tt("الراتب الأساسي", "Basic"), slip.basic], ...slip.items.filter((i: any) => i.kind === "earning").map((i: any) => [i.name_ar, i.amount]), [tt("الإضافي", "Overtime"), slip.overtime_pay],
        [tt("خصم الغياب", "Absence"), "-" + slip.absence_deduction], [tt("خصم التأخير والخروج المبكر", "Late / early"), "-" + (Number(slip.late_deduction) + Number(slip.early_deduction)).toFixed(3)],
        ...slip.items.filter((i: any) => i.kind === "deduction").map((i: any) => [i.name_ar, "-" + i.amount]), [tt("أقساط السلف", "Loan installment"), "-" + slip.loan_recovery],
        [tt("عجز العهدة", "Custody shortage"), "-" + slip.shortage_recovery], [tt("الصافي", "Net"), slip.net]]}
        cols={[{ h: "", v: (r) => r[0] }, { h: t.amount, v: (r) => fmt(r[1]), end: true }]} />
      <p style={{ color: "var(--muted)", fontSize: 12 }}>{tt("أيام العمل", "Work days")} {slip.work_days} · {tt("غياب", "absent")} {Number(slip.absent_days)} · {tt("دقائق التأخير المحتسبة", "charged late minutes")} {slip.late_minutes}</p>
    </Modal>}
    {lv && <Modal title={tt("طلب إجازة", "Leave request")} onClose={() => setLv(null)} footer={<><button className="btn" onClick={() => setLv(null)}>{t.cancel}</button>
      <button className="btn primary" onClick={async () => { try { await api.post("/hr/me/leave", lv); setLv(null); me.reload(); toast(tt("أُرسل الطلب", "Request sent")); } catch (e) { toast(errMsg(e, lang), true); } }}>{t.save}</button></>}>
      <div className="form-grid"><Field label={tt("النوع", "Type")}><select value={lv.leaveTypeId} onChange={(e) => setLv({ ...lv, leaveTypeId: e.target.value })}>{m.leaveTypes.map((x: any) => <option key={x.id} value={x.id}>{x.name_ar}</option>)}</select></Field>
        <Field label={t.from}><input type="date" value={lv.fromDate} onChange={(e) => setLv({ ...lv, fromDate: e.target.value })} /></Field>
        <Field label={t.to}><input type="date" value={lv.toDate} onChange={(e) => setLv({ ...lv, toDate: e.target.value })} /></Field></div>
    </Modal>}
  </div>;
}
