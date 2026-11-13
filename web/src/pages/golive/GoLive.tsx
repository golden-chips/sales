import { useState } from "react";
import { Link } from "react-router-dom";
import { api, fmt, fmtDateTime } from "../../api";
import { useI18n } from "../../i18n";
import { useSession } from "../../session";
import { Empty, ErrorBox, Field, Loading, Modal, errMsg, useAsync, useToast } from "../../ui";
import { LinesTable, today } from "../erp/shared";

const ICON: Record<string, string> = { ok: "✓", warn: "!", fail: "✕", na: "–" };
const BADGE: Record<string, string> = { ok: "ok", warn: "warn", fail: "bad", na: "" };

export function GoLive() {
  const { tt, lang, pick } = useI18n();
  const { can, companyId } = useSession();
  const { toast, confirm } = useToast();
  const r = useAsync(() => api.get(`/go-live/readiness?companyId=${companyId}`), [companyId]);
  const rec = useAsync(() => api.get(`/go-live/reconciliation?companyId=${companyId}`), [companyId]);
  const docs = useAsync(() => api.get(`/go-live/opening-documents?companyId=${companyId}`), [companyId]);
  const [signing, setSigning] = useState<string | null>(null);
  const [cutover, setCutover] = useState(today());
  const reload = () => { r.reload(); rec.reload(); docs.reload(); };
  const areaName = (a: string) => ({ accounting: tt("المحاسبة", "Accounting"), organisation: tt("التنظيم والمستخدمون", "Organisation & users"), master_data: tt("البيانات الأساسية", "Master data"),
    manufacturing: tt("التصنيع", "Manufacturing"), quality: tt("الجودة", "Quality"), distribution: tt("التوزيع", "Distribution"), hr: tt("الموارد البشرية", "HR"),
    opening: tt("الأرصدة الافتتاحية والمطابقة", "Opening balances & reconciliation"), signoff: tt("الاعتمادات", "Sign-offs") } as any)[a] ?? a;
  const drafts = [...(docs.data?.receivables ?? []), ...(docs.data?.payables ?? [])].filter((d: any) => d.status === "draft");
  const postOpening = async () => {
    if (!(await confirm(tt(`ترحيل ${drafts.length} رصيد افتتاحي بتاريخ ${cutover}؟`, `Post ${drafts.length} opening balances dated ${cutover}?`)))) return;
    try { const x = await api.post("/go-live/opening-documents/post", { companyId, cutoverDate: cutover }, { idempotencyKey: `ob-${companyId}-${cutover}-${drafts.length}` }); toast(`${x.receivables} + ${x.payables}`); reload(); }
    catch (e) { toast(errMsg(e, lang), true); }
  };
  const areas = [...new Set((r.data?.checks ?? []).map((c: any) => c.area))] as string[];
  return <>
    <div className="page-head"><h1>{tt("جاهزية التشغيل الفعلي", "Go-live readiness")}</h1><div className="row">
      <Link to="/uat" className="btn">{tt("اختبارات القبول", "Acceptance tests")}</Link>
      {can("core.golive.manage") && <button className="btn primary" disabled={!r.data?.ready} title={r.data?.ready ? "" : tt("أكمل البنود الحمراء أولًا", "Complete the red items first")} onClick={() => setSigning("go_live")}>{tt("اعتماد الإطلاق الفعلي", "Sign off go-live")}</button>}</div></div>
    <ErrorBox error={r.error} />
    {r.loading ? <Loading /> : r.data && <>
      <div className="grid kpis">
        <div className="card kpi"><div className="label">{tt("نسبة الجاهزية", "Readiness")}</div><div className="value num">{r.data.score}%</div></div>
        <div className="card kpi"><div className="label">{tt("بنود مانعة", "Blocking items")}</div><div className="value num">{r.data.blocking}</div></div>
        <div className="card kpi"><div className="label">{tt("تنبيهات", "Warnings")}</div><div className="value num">{r.data.warnings}</div></div>
        <div className="card kpi"><div className="label">{tt("الحالة", "Status")}</div><div className="value" style={{ fontSize: 18 }}>{r.data.ready ? `✓ ${tt("جاهز", "Ready")}` : `✕ ${tt("غير جاهز", "Not ready")}`}</div></div>
      </div>
      {areas.map((a) => <div key={a} style={{ marginTop: 16 }}><h3>{areaName(a)}</h3>
        <LinesTable rows={r.data.checks.filter((c: any) => c.area === a)} cols={[
          { h: "", v: (c) => <span className={`badge ${BADGE[c.status]}`}>{ICON[c.status]}</span> },
          { h: tt("البند", "Item"), v: (c) => pick(c.ar, c.en) }, { h: tt("التفاصيل", "Details"), v: (c) => <span style={{ fontSize: 12 }}>{c.detail}</span> },
          { h: "", v: (c) => c.key.startsWith("signoff_") || c.key === "coa_approved"
            ? <button className="btn" onClick={() => setSigning(c.key === "coa_approved" ? "chart_of_accounts" : c.key.replace("signoff_", ""))}>{c.status === "ok" ? tt("الاعتماد", "Sign-off") : tt("اعتماد", "Sign off")}</button>
            : c.link ? <Link to={c.link}>{tt("فتح", "Open")} ←</Link> : null }]} /></div>)}
    </>}

    <h3 style={{ marginTop: 24 }}>{tt("مطابقة الأستاذ المساعد مع الأستاذ العام", "Subledgers vs general ledger")}</h3>
    <p style={{ color: "var(--muted)", fontSize: 12 }}>{tt("كل حساب رقابة يجب أن يساوي مجموع تفاصيله (فواتير العملاء المفتوحة، أرصدة المخزون…). أي فرق يعني قيدًا مباشرًا على حساب رقابة أو رصيدًا افتتاحيًا ناقصًا.",
      "Each control account must equal the sum of its details (open customer invoices, stock balances…). A difference means a direct entry on a control account or a missing opening balance.")}</p>
    <ErrorBox error={rec.error} />
    {rec.data && <LinesTable rows={rec.data.rows} cols={[{ h: "", v: (x) => <span className={`badge ${x.ok ? "ok" : "bad"}`}>{x.ok ? "✓" : "✕"}</span> },
      { h: tt("الحساب", "Account"), v: (x) => <>{pick(x.ar, x.en)}{x.note ? <div style={{ fontSize: 11, color: "var(--muted)" }}>{pick(x.note.ar, x.note.en)}</div> : null}</> },
      { h: tt("الأستاذ العام", "GL"), v: (x) => fmt(x.gl), end: true }, { h: tt("التفاصيل", "Subledger"), v: (x) => fmt(x.subledger), end: true },
      { h: tt("الفرق", "Difference"), v: (x) => <b className="num">{fmt(x.difference)}</b>, end: true }, { h: "", v: (x) => <Link to={x.link}>{tt("فتح", "Open")} ←</Link> }]} />}

    <h3 style={{ marginTop: 24 }}>{tt("أرصدة العملاء والموردين الافتتاحية", "Opening customer & supplier balances")}</h3>
    <p style={{ color: "var(--muted)", fontSize: 12 }}>{tt("تُستورد من صفحة «استيراد Excel» (قالبَا أرصدة العملاء/الموردين) كمسودات، ثم يرحّلها مستخدم آخر هنا بتاريخ التحويل. كل رصيد يبقى بتاريخه الأصلي في أعمار الديون.",
      "Imported from «Excel import» (customer/supplier balance templates) as drafts, then posted here by another user on the cut-over date. Each keeps its original date for ageing.")}</p>
    {docs.data && <>
      {drafts.length ? <div className="row card" style={{ marginBottom: 8 }}><b>{drafts.length} {tt("مسودة", "drafts")}</b>
        <span className="num">{fmt(drafts.reduce((s: number, d: any) => s + Number(d.total), 0))}</span>
        <label className="row">{tt("تاريخ التحويل", "Cut-over date")} <input type="date" value={cutover} onChange={(e) => setCutover(e.target.value)} style={{ width: "auto" }} /></label>
        {can("accounting.journal.post") && <button className="btn primary" onClick={postOpening}>{tt("ترحيل الأرصدة الافتتاحية", "Post opening balances")}</button>}</div> : null}
      {[...docs.data.receivables.map((d: any) => ({ ...d, side: "AR" })), ...docs.data.payables.map((d: any) => ({ ...d, side: "AP" }))].length
        ? <LinesTable rows={[...docs.data.receivables.map((d: any) => ({ ...d, side: tt("عميل", "Customer") })), ...docs.data.payables.map((d: any) => ({ ...d, side: tt("مورد", "Supplier") }))]} cols={[
          { h: tt("الطرف", "Party"), v: (d) => `${d.side} · ${d.code} · ${d.name_ar}` }, { h: tt("المرجع القديم", "Old reference"), v: (d) => d.opening_reference ?? d.reference ?? "—" },
          { h: tt("التاريخ", "Date"), v: (d) => String(d.invoice_date).slice(0, 10) }, { h: tt("المبلغ", "Amount"), v: (d) => fmt(d.total), end: true },
          { h: tt("الحالة", "Status"), v: (d) => d.status === "posted" ? <span className="badge ok">{tt("مرحّل", "Posted")}</span> : <span className="badge warn">{tt("مسودة", "Draft")}</span> }]} />
        : <Empty text={tt("لم تُستورد أرصدة بعد", "Nothing imported yet")} />}
    </>}

    {r.data?.signoffs?.length ? <><h3 style={{ marginTop: 24 }}>{tt("الاعتمادات المسجلة", "Recorded sign-offs")}</h3>
      <LinesTable rows={r.data.signoffs} cols={[{ h: tt("المرحلة", "Stage"), v: (s) => s.item }, { h: tt("اعتمدها", "By"), v: (s) => s.full_name }, { h: tt("التاريخ", "Date"), v: (s) => fmtDateTime(s.approved_at) }, { h: tt("ملاحظة", "Note"), v: (s) => s.note ?? "" }]} /></> : null}
    {signing && <SignOff item={signing} onClose={() => { setSigning(null); reload(); }} existing={(r.data?.signoffs ?? []).find((s: any) => s.item === signing)} />}
  </>;
}

function SignOff({ item, existing, onClose }: { item: string; existing?: any; onClose: () => void }) {
  const { t, tt, lang } = useI18n();
  const { companyId } = useSession();
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const title = ({ chart_of_accounts: tt("اعتماد دليل الحسابات", "Sign off the chart of accounts"), opening_balances: tt("اعتماد الأرصدة الافتتاحية", "Sign off opening balances"),
    uat: tt("اعتماد اختبارات القبول", "Sign off acceptance tests"), go_live: tt("اعتماد الإطلاق الفعلي", "Sign off go-live") } as any)[item];
  const who = ({ chart_of_accounts: tt("المحاسب المسؤول (صلاحية إدارة الحسابات)", "the accountant (manage accounts)"), opening_balances: tt("المدير المالي (صلاحية الترحيل) — يتطلب مطابقة كاملة", "finance (posting rights) — requires a clean reconciliation"),
    uat: tt("مدير النظام بعد نجاح الاختبارات", "the administrator once tests pass"), go_live: tt("الإدارة — يتطلب عدم وجود بنود مانعة", "management — no blocking items allowed") } as any)[item];
  const act = async (revoke: boolean) => {
    try {
      if (revoke) await api.post("/go-live/signoffs/revoke", { companyId, item, reason: note || "—" });
      else await api.post("/go-live/signoffs", { companyId, item, note: note || undefined });
      toast(t.savedOk); onClose();
    } catch (e) { toast(errMsg(e, lang), true); }
  };
  return <Modal title={title} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t.cancel}</button>
    {existing ? <button className="btn danger" disabled={note.length < 3} onClick={() => act(true)}>{tt("سحب الاعتماد", "Revoke")}</button> : <button className="btn primary" onClick={() => act(false)}>{tt("اعتماد", "Sign off")}</button>}</>}>
    <p>{tt("يعتمدها:", "Signed off by:")} {who}</p>
    {existing && <div className="alert info">{tt("معتمد بواسطة", "Signed off by")} {existing.full_name} · {fmtDateTime(existing.approved_at)}</div>}
    <Field label={existing ? tt("سبب السحب", "Reason to revoke") : tt("ملاحظة", "Note")}><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
  </Modal>;
}

export function Uat() {
  const { tt, lang } = useI18n();
  const { companyId } = useSession();
  const { toast } = useToast();
  const d = useAsync(() => api.get(`/uat/scenarios?companyId=${companyId}`), [companyId]);
  const [open, setOpen] = useState<any | null>(null);
  const [notes, setNotes] = useState("");
  const record = async (status: string) => {
    try { await api.post("/uat/results", { companyId, scenarioKey: open.key, status, notes: notes || undefined }); setOpen(null); setNotes(""); d.reload(); }
    catch (e) { toast(errMsg(e, lang), true); }
  };
  const st = (s?: string) => s === "pass" ? <span className="badge ok">✓ {tt("نجح", "Pass")}</span> : s === "fail" ? <span className="badge bad">✕ {tt("فشل", "Fail")}</span>
    : s === "blocked" ? <span className="badge warn">! {tt("معطّل", "Blocked")}</span> : <span className="badge">{tt("لم يُختبر", "Not run")}</span>;
  return <>
    <div className="page-head"><h1>{tt("اختبارات قبول المستخدمين (UAT)", "User acceptance tests")}</h1></div>
    <div className="alert info">{tt("ينفّذ كل موظف السيناريوهات الخاصة بعمله على بيانات الشركة، ويسجّل النتيجة. الفشل يتطلب وصف المشكلة. آخر نتيجة لكل سيناريو هي المعتمدة.",
      "Each employee runs the scenarios of their job on the company's data and records the result. A failure needs a description. The latest result of each scenario counts.")}</div>
    <ErrorBox error={d.error} />
    {d.loading ? <Loading /> : d.data && <>
      <div className="grid kpis">
        <div className="card kpi"><div className="label">{tt("نجح", "Passed")}</div><div className="value num">{d.data.summary.pass} / {d.data.summary.total}</div></div>
        <div className="card kpi"><div className="label">{tt("فشل", "Failed")}</div><div className="value num">{d.data.summary.fail}</div></div>
        <div className="card kpi"><div className="label">{tt("معطّل", "Blocked")}</div><div className="value num">{d.data.summary.blocked}</div></div>
        <div className="card kpi"><div className="label">{tt("لم يُختبر", "Not run")}</div><div className="value num">{d.data.summary.notRun}</div></div>
      </div>
      <LinesTable rows={d.data.scenarios} cols={[{ h: tt("السيناريو", "Scenario"), v: (s) => <><b>{s.ar}</b><div style={{ fontSize: 12, color: "var(--muted)" }}>{s.role}</div></> },
        { h: tt("النتيجة", "Result"), v: (s) => <>{st(s.latest?.status)}{s.latest ? <div style={{ fontSize: 11, color: "var(--muted)" }}>{s.latest.tester} · {fmtDateTime(s.latest.tested_at)}</div> : null}</> },
        { h: tt("ملاحظات", "Notes"), v: (s) => <span style={{ fontSize: 12 }}>{s.latest?.notes ?? ""}</span> }, { h: "", v: (s) => <button className="btn" onClick={() => setOpen(s)}>{tt("تنفيذ", "Run")}</button> }]} />
    </>}
    {open && <Modal title={open.ar} onClose={() => setOpen(null)} footer={<><button className="btn" onClick={() => record("blocked")}>{tt("معطّل", "Blocked")}</button>
      <button className="btn danger" onClick={() => record("fail")}>✕ {tt("فشل", "Fail")}</button><button className="btn primary" onClick={() => record("pass")}>✓ {tt("نجح", "Pass")}</button></>}>
      <p style={{ color: "var(--muted)" }}>{open.role}</p>
      <h3>{tt("الخطوات", "Steps")}</h3><ol>{open.steps.map((x: string, i: number) => <li key={i}>{x}</li>)}</ol>
      <h3>{tt("النتيجة المتوقعة", "Expected result")}</h3><p>{open.expected}</p>
      <Field label={tt("ملاحظات (إلزامية عند الفشل)", "Notes (required on failure)")}><textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
    </Modal>}
  </>;
}
