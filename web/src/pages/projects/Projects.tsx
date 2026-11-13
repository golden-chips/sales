import { useState } from "react";
import { api, fmt, fmtDate } from "../../api";
import { useI18n } from "../../i18n";
import { useSession } from "../../session";
import { Empty, ErrorBox, Field, Loading, Modal, errMsg, useAsync, useToast } from "../../ui";
import { LinesTable, today } from "../erp/shared";

/** thin progress bar with the value as text beside it (not colour alone) */
function Bar({ pct, bad }: { pct: number | null; bad?: boolean }) {
  const v = Math.max(0, Math.min(100, pct ?? 0));
  return <div className="row" style={{ gap: 6 }}><div style={{ flex: 1, height: 8, background: "var(--surface-2)", borderRadius: 4, minWidth: 60, border: "1px solid var(--line)" }}>
    <div style={{ width: `${v}%`, height: "100%", borderRadius: 4, background: bad ? "var(--bad)" : "var(--series-1)" }} /></div><span className="num" style={{ fontSize: 12 }}>{pct === null ? "—" : `${pct}%`}</span></div>;
}

export function ProjectsPage() {
  const { t, tt } = useI18n();
  const { can, companyId } = useSession();
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useAsync(() => api.get(`/projects?companyId=${companyId}`), [companyId]);
  const st = (s: string) => ({ planned: tt("مخطط", "Planned"), active: tt("نشط", "Active"), on_hold: tt("متوقف", "On hold"), done: tt("منجز", "Done"), cancelled: tt("ملغى", "Cancelled") } as any)[s] ?? s;
  return <>
    <div className="page-head"><h1>{tt("المشاريع", "Projects")}</h1>{can("projects.manage") && <button className="btn primary" onClick={() => setCreating(true)}>{tt("مشروع جديد", "New project")}</button>}</div>
    <ErrorBox error={list.error} />
    {list.loading ? <Loading /> : !list.data?.length ? <div className="card"><Empty /></div> : <div className="table-wrap"><table>
      <thead><tr><th>{t.code}</th><th>{t.name}</th><th>{tt("المدير", "Manager")}</th><th>{tt("الإنجاز", "Progress")}</th><th className="end">{tt("الميزانية", "Budget")}</th>
        <th className="end">{tt("الفعلي", "Actual")}</th><th>{tt("استهلاك الميزانية", "Budget used")}</th><th>{t.status}</th></tr></thead>
      <tbody>{list.data.map((p: any) => <tr key={p.id} style={{ cursor: "pointer" }} onClick={() => setOpenId(p.id)}>
        <td className="num">{p.code}</td><td>{p.name_ar}{p.overdue ? <span className="badge bad" style={{ marginInlineStart: 4 }}>{p.overdue} {tt("متأخرة", "late")}</span> : null}</td><td>{p.manager_name}</td>
        <td style={{ minWidth: 120 }}><Bar pct={p.progress_pct === null ? null : Number(p.progress_pct)} /></td><td className="end num">{fmt(p.budget)}</td><td className="end num">{fmt(p.actual_cost)}</td>
        <td style={{ minWidth: 120 }}><Bar pct={p.budget_used_pct} bad={p.over_budget} />{p.over_budget ? <span className="badge bad">{tt("تجاوز الميزانية", "Over budget")}</span> : null}</td><td>{st(p.status)}</td></tr>)}</tbody></table></div>}
    {creating && <NewProject onClose={() => { setCreating(false); list.reload(); }} />}
    {openId && <ProjectCard id={openId} onClose={() => { setOpenId(null); list.reload(); }} />}
  </>;
}

function NewProject({ onClose }: { onClose: () => void }) {
  const { t, tt, lang } = useI18n();
  const { companyId } = useSession();
  const { toast } = useToast();
  const [f, setF] = useState({ code: "", nameAr: "", startDate: today(), endDate: "", budget: "0", description: "" });
  const save = async () => {
    try { await api.post("/projects", { companyId, ...f, endDate: f.endDate || undefined, description: f.description || undefined }); toast(t.savedOk); onClose(); }
    catch (e) { toast(errMsg(e, lang), true); }
  };
  return <Modal title={tt("مشروع جديد", "New project")} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t.cancel}</button><button className="btn primary" onClick={save}>{t.save}</button></>}>
    <div className="alert info">{tt("يُنشأ للمشروع مركز تكلفة. كل قيد أو فاتورة مورد يُحمَّل على مركز التكلفة هذا يظهر كتكلفة فعلية للمشروع.", "A cost centre is created for the project. Any entry or supplier invoice charged to it shows as an actual cost of the project.")}</div>
    <div className="form-grid">
      <Field label={t.code}><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
      <Field label={t.name}><input value={f.nameAr} onChange={(e) => setF({ ...f, nameAr: e.target.value })} /></Field>
      <Field label={tt("البداية", "Start")}><input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></Field>
      <Field label={tt("النهاية", "End")}><input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
      <Field label={tt("الميزانية", "Budget")}><input className="num" value={f.budget} onChange={(e) => setF({ ...f, budget: e.target.value })} /></Field>
    </div>
    <Field label={tt("الوصف", "Description")}><textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
  </Modal>;
}

function ProjectCard({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, tt, lang } = useI18n();
  const { can, me } = useSession();
  const { toast } = useToast();
  const p = useAsync(() => api.get(`/projects/${id}`), [id]);
  const users = useAsync(() => (can("core.users.view") ? api.get("/users") : Promise.resolve([])), []);
  const [task, setTask] = useState({ title: "", dueDate: "", estimateHours: "8", assigneeId: "" });
  const addTask = async () => {
    try { await api.post(`/projects/${id}/tasks`, { title: task.title, dueDate: task.dueDate || undefined, estimateHours: Number(task.estimateHours) || 1, assigneeId: task.assigneeId || undefined }); setTask({ ...task, title: "" }); p.reload(); }
    catch (e) { toast(errMsg(e, lang), true); }
  };
  const setProgress = async (tk: any, v: number) => { try { await api.patch(`/projects/tasks/${tk.id}`, { progressPct: v }); p.reload(); } catch (e) { toast(errMsg(e, lang), true); } };
  const setStatus = async (s: string) => { try { await api.patch(`/projects/${id}`, { status: s }); p.reload(); } catch (e) { toast(errMsg(e, lang), true); } };
  const d = p.data;
  return <Modal title={d ? `${d.code} — ${d.name_ar}` : "…"} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t.close}</button>
    {d && can("projects.manage") && <select value={d.status} onChange={(e) => setStatus(e.target.value)} style={{ width: "auto" }}>
      {["planned", "active", "on_hold", "done", "cancelled"].map((s) => <option key={s} value={s}>{s}</option>)}</select>}</>}>
    <ErrorBox error={p.error} />
    {!d ? <Loading /> : <>
      <div className="grid kpis">
        <div className="card kpi"><div className="label">{tt("الإنجاز", "Progress")}</div><div className="value num">{d.progress_pct ?? "—"}%</div><div className="num" style={{ fontSize: 12 }}>{d.done}/{d.tasks} {tt("مهام", "tasks")}</div></div>
        <div className="card kpi"><div className="label">{tt("الميزانية / الفعلي", "Budget / actual")}</div><div className="value num">{fmt(d.actual_cost)}</div><div className="num" style={{ fontSize: 12 }}>{tt("من", "of")} {fmt(d.budget)} · {d.budget_used_pct ?? "—"}%</div></div>
        <div className="card kpi"><div className="label">{tt("مركز التكلفة", "Cost centre")}</div><div className="value num" style={{ fontSize: 18 }}>{d.cost_center_code}</div></div>
      </div>
      <h3>{tt("المهام", "Tasks")}</h3>
      {d.task_list.length ? <LinesTable rows={d.task_list} cols={[{ h: tt("المهمة", "Task"), v: (x) => x.title }, { h: tt("المسؤول", "Assignee"), v: (x) => x.assignee_name ?? "—" },
        { h: tt("الاستحقاق", "Due"), v: (x) => <span className={x.overdue ? "badge bad" : ""}>{fmtDate(x.due_date)}</span> }, { h: tt("ساعات", "Hours"), v: (x) => Number(x.estimate_hours), end: true },
        { h: tt("الإنجاز", "Progress"), v: (x) => (can("projects.manage") || x.assignee_id === me?.user.id) && x.status !== "done"
          ? <select value={x.progress_pct} onChange={(e) => setProgress(x, Number(e.target.value))} style={{ width: "auto" }}>{[0, 25, 50, 75, 100].map((v) => <option key={v} value={v}>{v}%</option>)}</select>
          : <Bar pct={x.progress_pct} /> }]} /> : <Empty />}
      {can("projects.manage") && <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
        <input placeholder={tt("مهمة جديدة", "New task")} value={task.title} onChange={(e) => setTask({ ...task, title: e.target.value })} style={{ flex: 1, minWidth: 160 }} />
        <select value={task.assigneeId} onChange={(e) => setTask({ ...task, assigneeId: e.target.value })} style={{ width: "auto" }}><option value="">{tt("المسؤول", "Assignee")}</option>
          {(users.data ?? []).map((u: any) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</select>
        <input type="date" value={task.dueDate} onChange={(e) => setTask({ ...task, dueDate: e.target.value })} style={{ width: "auto" }} />
        <input className="num" title={tt("ساعات تقديرية", "Estimated hours")} value={task.estimateHours} onChange={(e) => setTask({ ...task, estimateHours: e.target.value })} style={{ width: 60 }} />
        <button className="btn primary" disabled={!task.title} onClick={addTask}>{t.add}</button></div>}
      <h3>{tt("التكاليف الفعلية (من الأستاذ العام)", "Actual costs (from the general ledger)")}</h3>
      {d.costs.length ? <LinesTable rows={d.costs} cols={[{ h: t.date, v: (c) => c.date }, { h: t.number, v: (c) => c.number }, { h: t.account, v: (c) => `${c.account_code} · ${c.account_name}` },
        { h: t.memo, v: (c) => c.description }, { h: t.amount, v: (c) => fmt(c.amount), end: true }]} /> : <Empty text={tt("لا توجد تكاليف بعد — اختر مركز تكلفة المشروع عند تسجيل القيود", "No costs yet — choose the project's cost centre on journal lines")} />}
    </>}
  </Modal>;
}

export function MyProjectTasks() {
  const { tt } = useI18n();
  const list = useAsync(() => api.get("/projects/my-tasks"), []);
  return <>
    <div className="page-head"><h1>{tt("مهامي في المشاريع", "My project tasks")}</h1></div>
    {list.loading ? <Loading /> : !list.data?.length ? <div className="card"><Empty /></div> : <LinesTable rows={list.data} cols={[{ h: tt("المشروع", "Project"), v: (x) => `${x.project_code} · ${x.project_name}` },
      { h: tt("المهمة", "Task"), v: (x) => x.title }, { h: tt("الاستحقاق", "Due"), v: (x) => <span className={x.overdue ? "badge bad" : ""}>{fmtDate(x.due_date)}</span> }, { h: tt("الإنجاز", "Progress"), v: (x) => <Bar pct={x.progress_pct} /> }]} />}
  </>;
}
