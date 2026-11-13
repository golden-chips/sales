import { useState } from "react";
import { api, fmt, fmtDate, fmtDateTime } from "../../api";
import { useI18n } from "../../i18n";
import { useSession } from "../../session";
import { Empty, ErrorBox, Field, Loading, Modal, errMsg, useAsync, useToast } from "../../ui";
import { LinesTable } from "../erp/shared";

const STAGES = ["prospecting", "proposal", "negotiation", "won", "lost"] as const;
function useLabels() {
  const { tt } = useI18n();
  return {
    stage: (s: string) => ({ prospecting: tt("استكشاف", "Prospecting"), proposal: tt("عرض سعر", "Proposal"), negotiation: tt("تفاوض", "Negotiation"), won: tt("ربح", "Won"), lost: tt("خسارة", "Lost") } as any)[s] ?? s,
    lead: (s: string) => ({ new: tt("جديد", "New"), contacted: tt("تم التواصل", "Contacted"), qualified: tt("مؤهل", "Qualified"), converted: tt("تحوّل لعميل", "Converted"), lost: tt("مفقود", "Lost") } as any)[s] ?? s,
    ticket: (s: string) => ({ open: tt("مفتوحة", "Open"), in_progress: tt("قيد المعالجة", "In progress"), resolved: tt("محلولة", "Resolved"), closed: tt("مغلقة", "Closed") } as any)[s] ?? s,
    kind: (s: string) => ({ complaint: tt("شكوى", "Complaint"), inquiry: tt("استفسار", "Inquiry"), service: tt("خدمة", "Service"), suggestion: tt("اقتراح", "Suggestion") } as any)[s] ?? s,
  };
}

export function CrmLeads() {
  const { t, tt, lang } = useI18n();
  const { can, companyId } = useSession();
  const { toast } = useToast();
  const L = useLabels();
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [converting, setConverting] = useState<any | null>(null);
  const list = useAsync(() => api.get(`/crm/leads?companyId=${companyId}${status ? `&status=${status}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`), [companyId, status, q]);
  const move = async (id: string, s: string) => {
    try {
      const lostReason = s === "lost" ? window.prompt(tt("سبب الفقد", "Reason lost")) ?? "" : undefined;
      if (s === "lost" && !lostReason) return;
      await api.post(`/crm/leads/${id}/status`, { status: s, lostReason }); list.reload();
    } catch (e) { toast(errMsg(e, lang), true); }
  };
  return <>
    <div className="page-head"><h1>{tt("العملاء المحتملون", "Leads")}</h1><div className="row">
      <input type="search" placeholder={tt("اسم أو هاتف", "Name or phone")} value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 180 }} />
      <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: "auto" }}><option value="">{t.status}: *</option>
        {["new", "contacted", "qualified", "converted", "lost"].map((s) => <option key={s} value={s}>{L.lead(s)}</option>)}</select>
      {can("crm.manage") && <button className="btn primary" onClick={() => setCreating(true)}>{tt("عميل محتمل جديد", "New lead")}</button>}</div></div>
    <ErrorBox error={list.error} />
    {list.loading ? <Loading /> : !list.data?.length ? <div className="card"><Empty /></div> : <LinesTable rows={list.data} cols={[
      { h: t.name, v: (l) => <><b>{l.business_name ?? l.name}</b>{l.business_name ? <div style={{ fontSize: 12, color: "var(--muted)" }}>{l.name}</div> : null}</> },
      { h: tt("الهاتف", "Phone"), v: (l) => <span className="num">{l.phone ?? "—"}</span> }, { h: tt("المدينة", "City"), v: (l) => l.city ?? "—" },
      { h: tt("المصدر", "Source"), v: (l) => l.campaign_name ?? l.source }, { h: tt("المسؤول", "Owner"), v: (l) => l.owner_name ?? "—" },
      { h: t.status, v: (l) => <span className={`badge ${l.status === "converted" ? "ok" : l.status === "lost" ? "bad" : ""}`}>{L.lead(l.status)}</span> },
      { h: "", v: (l) => can("crm.manage") && !["converted", "lost"].includes(l.status) ? <div className="row">
        {l.status === "new" && <button className="btn" onClick={() => move(l.id, "contacted")}>{L.lead("contacted")}</button>}
        {l.status === "contacted" && <button className="btn" onClick={() => move(l.id, "qualified")}>{L.lead("qualified")}</button>}
        {can("sales.customers.manage") && <button className="btn primary" onClick={() => setConverting(l)}>{tt("تحويل لعميل", "Convert")}</button>}
        <button className="btn" onClick={() => move(l.id, "lost")}>✕</button></div> : null }]} />}
    {creating && <NewLead onClose={() => { setCreating(false); list.reload(); }} />}
    {converting && <Convert lead={converting} onClose={() => { setConverting(null); list.reload(); }} />}
  </>;
}

function NewLead({ onClose }: { onClose: () => void }) {
  const { t, tt, lang } = useI18n();
  const { companyId } = useSession();
  const { toast } = useToast();
  const camps = useAsync(() => api.get(`/crm/campaigns?companyId=${companyId}`), [companyId]);
  const [f, setF] = useState({ name: "", businessName: "", phone: "", city: "", source: "rep_visit", campaignId: "", notes: "" });
  const [err, setErr] = useState<unknown>(null);
  const save = async () => {
    setErr(null);
    try { await api.post("/crm/leads", { companyId, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v !== "")) }); toast(t.savedOk); onClose(); }
    catch (e) { setErr(e); toast(errMsg(e, lang), true); }
  };
  return <Modal title={tt("عميل محتمل جديد", "New lead")} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t.cancel}</button><button className="btn primary" onClick={save}>{t.save}</button></>}>
    <ErrorBox error={err} />
    <div className="form-grid">
      <Field label={tt("اسم المحل/الشركة", "Business name")}><input value={f.businessName} onChange={(e) => setF({ ...f, businessName: e.target.value })} /></Field>
      <Field label={tt("الشخص المسؤول", "Contact person")}><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label={tt("الهاتف", "Phone")}><input className="num" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
      <Field label={tt("المدينة", "City")}><input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
      <Field label={tt("المصدر", "Source")}><select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
        {[["rep_visit", tt("زيارة مندوب", "Rep visit")], ["referral", tt("توصية", "Referral")], ["campaign", tt("حملة", "Campaign")], ["phone", tt("اتصال", "Phone")], ["exhibition", tt("معرض", "Exhibition")], ["website", tt("موقع", "Website")], ["other", tt("أخرى", "Other")]]
          .map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      <Field label={tt("الحملة", "Campaign")}><select value={f.campaignId} onChange={(e) => setF({ ...f, campaignId: e.target.value })}><option value="">—</option>
        {(camps.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
    </div>
    <Field label={tt("ملاحظات", "Notes")}><textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
  </Modal>;
}

function Convert({ lead, onClose }: { lead: any; onClose: () => void }) {
  const { t, tt, lang } = useI18n();
  const { toast } = useToast();
  const [f, setF] = useState({ customerCode: "", creditLimit: "", paymentTermsDays: "0" });
  const save = async () => {
    try { const r = await api.post(`/crm/leads/${lead.id}/convert`, { customerCode: f.customerCode, creditLimit: f.creditLimit || undefined, paymentTermsDays: Number(f.paymentTermsDays) }); toast(`${t.savedOk} — ${r.customer.code}`); onClose(); }
    catch (e) { toast(errMsg(e, lang), true); }
  };
  return <Modal title={`${tt("تحويل إلى عميل", "Convert to customer")}: ${lead.business_name ?? lead.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t.cancel}</button><button className="btn primary" onClick={save}>{t.save}</button></>}>
    <div className="form-grid">
      <Field label={tt("رمز العميل", "Customer code")}><input value={f.customerCode} onChange={(e) => setF({ ...f, customerCode: e.target.value.toUpperCase() })} /></Field>
      <Field label={tt("حد الائتمان", "Credit limit")}><input className="num" value={f.creditLimit} onChange={(e) => setF({ ...f, creditLimit: e.target.value })} /></Field>
      <Field label={tt("أيام السداد", "Payment terms (days)")}><input className="num" value={f.paymentTermsDays} onChange={(e) => setF({ ...f, paymentTermsDays: e.target.value })} /></Field>
    </div>
  </Modal>;
}

export function CrmPipeline() {
  const { t, tt, lang } = useI18n();
  const { can, companyId } = useSession();
  const { toast } = useToast();
  const L = useLabels();
  const opps = useAsync(() => api.get(`/crm/opportunities?companyId=${companyId}`), [companyId]);
  const pipe = useAsync(() => api.get(`/crm/pipeline?companyId=${companyId}`), [companyId]);
  const [creating, setCreating] = useState(false);
  const move = async (o: any, stage: string) => {
    try {
      const lostReason = stage === "lost" ? window.prompt(tt("سبب الخسارة", "Reason lost")) ?? "" : undefined;
      if (stage === "lost" && !lostReason) return;
      await api.post(`/crm/opportunities/${o.id}/stage`, { stage, lostReason }); opps.reload(); pipe.reload();
    } catch (e) { toast(errMsg(e, lang), true); }
  };
  const next: Record<string, string> = { prospecting: "proposal", proposal: "negotiation", negotiation: "won" };
  return <>
    <div className="page-head"><h1>{tt("مسار الفرص البيعية", "Sales pipeline")}</h1>
      {can("crm.manage") && <button className="btn primary" onClick={() => setCreating(true)}>{tt("فرصة جديدة", "New opportunity")}</button>}</div>
    {pipe.data && <div className="grid kpis">
      {pipe.data.stages.filter((s: any) => !["won", "lost"].includes(s.stage)).map((s: any) => <div key={s.stage} className="card kpi"><div className="label">{L.stage(s.stage)} · {s.n}</div>
        <div className="value num">{fmt(s.value)}</div><div className="num" style={{ fontSize: 12, color: "var(--muted)" }}>{tt("مرجّح", "Weighted")} {fmt(s.weighted)}</div></div>)}
      <div className="card kpi"><div className="label">{tt("نسبة الربح", "Win rate")}</div><div className="value num">{pipe.data.winRate === null ? "—" : `${pipe.data.winRate}%`}</div></div></div>}
    <ErrorBox error={opps.error} />
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginTop: 16 }}>
      {STAGES.map((st) => <div key={st} className="card" style={{ padding: 10 }}>
        <h3 style={{ marginTop: 0 }}>{L.stage(st)}</h3>
        {(opps.data ?? []).filter((o: any) => o.stage === st).map((o: any) => <div key={o.id} className="card" style={{ padding: 8, marginBottom: 8 }}>
          <b>{o.title}</b><div style={{ fontSize: 12, color: "var(--muted)" }}>{o.party_name} · {o.owner_name}</div>
          <div className="row" style={{ justifyContent: "space-between" }}><span className="num">{fmt(o.expected_value)}</span><span className="num" style={{ fontSize: 12 }}>{o.probability}%</span></div>
          {can("crm.manage") && next[st] && <div className="row" style={{ marginTop: 6 }}><button className="btn" onClick={() => move(o, next[st])}>{lang === "ar" ? "←" : "→"} {L.stage(next[st])}</button>
            <button className="btn" onClick={() => move(o, "lost")}>✕</button></div>}
        </div>)}
      </div>)}
    </div>
    {creating && <NewOpportunity onClose={() => { setCreating(false); opps.reload(); pipe.reload(); }} />}
  </>;
}

function NewOpportunity({ onClose }: { onClose: () => void }) {
  const { t, tt, lang } = useI18n();
  const { companyId } = useSession();
  const { toast } = useToast();
  const leads = useAsync(() => api.get(`/crm/leads?companyId=${companyId}`), [companyId]);
  const custs = useAsync(() => api.get(`/customers?companyId=${companyId}&pageSize=200`), [companyId]);
  const [f, setF] = useState({ title: "", party: "", expectedValue: "", expectedClose: "" });
  const save = async () => {
    try {
      const [kind, id] = f.party.split(":");
      await api.post("/crm/opportunities", { companyId, title: f.title, leadId: kind === "lead" ? id : undefined, customerId: kind === "cust" ? id : undefined,
        expectedValue: f.expectedValue || "0", expectedClose: f.expectedClose || undefined });
      toast(t.savedOk); onClose();
    } catch (e) { toast(errMsg(e, lang), true); }
  };
  return <Modal title={tt("فرصة جديدة", "New opportunity")} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t.cancel}</button><button className="btn primary" onClick={save}>{t.save}</button></>}>
    <div className="form-grid">
      <Field label={tt("العنوان", "Title")}><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      <Field label={tt("العميل / المحتمل", "Customer / lead")}><select value={f.party} onChange={(e) => setF({ ...f, party: e.target.value })}><option value="">…</option>
        <optgroup label={tt("عملاء", "Customers")}>{(custs.data?.data ?? []).map((c: any) => <option key={c.id} value={`cust:${c.id}`}>{c.code} · {c.name_ar}</option>)}</optgroup>
        <optgroup label={tt("محتملون", "Leads")}>{(leads.data ?? []).filter((l: any) => !["converted", "lost"].includes(l.status)).map((l: any) => <option key={l.id} value={`lead:${l.id}`}>{l.business_name ?? l.name}</option>)}</optgroup></select></Field>
      <Field label={tt("القيمة المتوقعة", "Expected value")}><input className="num" value={f.expectedValue} onChange={(e) => setF({ ...f, expectedValue: e.target.value })} /></Field>
      <Field label={tt("الإغلاق المتوقع", "Expected close")}><input type="date" value={f.expectedClose} onChange={(e) => setF({ ...f, expectedClose: e.target.value })} /></Field>
    </div>
  </Modal>;
}

export function CrmTickets() {
  const { t, tt, lang } = useI18n();
  const { can, companyId } = useSession();
  const { toast } = useToast();
  const L = useLabels();
  const [status, setStatus] = useState("open");
  const [creating, setCreating] = useState(false);
  const list = useAsync(() => api.get(`/crm/tickets?companyId=${companyId}${status ? `&status=${status}` : ""}`), [companyId, status]);
  const year = new Date().toISOString().slice(0, 4);
  const stats = useAsync(() => api.get(`/crm/service-stats?companyId=${companyId}&from=${year}-01-01&to=${new Date().toISOString().slice(0, 10)}`), [companyId]);
  const act = async (tk: any, s: string) => {
    try {
      const resolution = s === "resolved" ? window.prompt(tt("الحل / ما تم", "Resolution")) ?? "" : undefined;
      if (s === "resolved" && !resolution) return;
      await api.post(`/crm/tickets/${tk.id}/status`, { status: s, resolution }); list.reload(); stats.reload();
    } catch (e) { toast(errMsg(e, lang), true); }
  };
  const rate = async (tk: any) => {
    const score = Number(window.prompt(tt("رضا العميل من 1 إلى 5", "Customer satisfaction 1–5")) ?? "");
    if (!score) return;
    try { await api.post(`/crm/tickets/${tk.id}/feedback`, { score }); list.reload(); stats.reload(); } catch (e) { toast(errMsg(e, lang), true); }
  };
  return <>
    <div className="page-head"><h1>{tt("خدمة العملاء والشكاوى", "Customer service & complaints")}</h1><div className="row">
      <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: "auto" }}><option value="">{t.status}: *</option>
        {["open", "in_progress", "resolved", "closed"].map((s) => <option key={s} value={s}>{L.ticket(s)}</option>)}</select>
      {can("crm.tickets.manage") && <button className="btn primary" onClick={() => setCreating(true)}>{tt("تذكرة جديدة", "New ticket")}</button>}</div></div>
    {stats.data && <div className="grid kpis">
      <div className="card kpi"><div className="label">{tt("مفتوحة", "Open")}</div><div className="value num">{stats.data.open}</div></div>
      <div className="card kpi"><div className="label">{tt("تجاوزت وقت الاستجابة", "SLA breached")}</div><div className="value num">{stats.data.sla_breached}</div></div>
      <div className="card kpi"><div className="label">{tt("متوسط زمن الحل (ساعة)", "Avg. resolution (h)")}</div><div className="value num">{stats.data.avg_resolution_hours ?? "—"}</div></div>
      <div className="card kpi"><div className="label">{tt("رضا العملاء (من 5)", "Satisfaction (of 5)")}</div><div className="value num">{stats.data.csat_avg ?? "—"}</div></div></div>}
    <ErrorBox error={list.error} />
    {list.loading ? <Loading /> : !list.data?.length ? <div className="card"><Empty /></div> : <LinesTable rows={list.data} cols={[
      { h: t.number, v: (x) => <span className="num">{x.number}</span> }, { h: tt("العميل", "Customer"), v: (x) => x.customer_name },
      { h: tt("النوع", "Kind"), v: (x) => L.kind(x.kind) }, { h: tt("الموضوع", "Subject"), v: (x) => <>{x.subject}{x.lot_no ? <div style={{ fontSize: 12 }}>{tt("التشغيلة", "Lot")} {x.lot_no}{x.ncr_number ? ` · ${x.ncr_number}` : ""}</div> : null}</> },
      { h: tt("موعد الرد", "Due"), v: (x) => <span className={x.breached ? "badge bad" : ""}>{x.breached ? "⚠ " : ""}{fmtDateTime(x.due_at)}</span> },
      { h: t.status, v: (x) => <>{L.ticket(x.status)}{x.csat_score ? ` · ${"★".repeat(x.csat_score)}` : ""}</> },
      { h: "", v: (x) => can("crm.tickets.manage") ? <div className="row">
        {x.status === "open" && <button className="btn" onClick={() => act(x, "in_progress")}>{L.ticket("in_progress")}</button>}
        {["open", "in_progress"].includes(x.status) && <button className="btn primary" onClick={() => act(x, "resolved")}>{tt("حل", "Resolve")}</button>}
        {x.status === "resolved" && !x.csat_score && <button className="btn" onClick={() => rate(x)}>★</button>}
        {x.status === "resolved" && <button className="btn" onClick={() => act(x, "closed")}>{tt("إغلاق", "Close")}</button>}</div> : null }]} />}
    {creating && <NewTicket onClose={() => { setCreating(false); list.reload(); stats.reload(); }} />}
  </>;
}

function NewTicket({ onClose }: { onClose: () => void }) {
  const { t, tt, lang } = useI18n();
  const { companyId, me } = useSession();
  const { toast } = useToast();
  const L = useLabels();
  const custs = useAsync(() => api.get(`/customers?companyId=${companyId}&pageSize=200`), [companyId]);
  const lots = useAsync(() => api.get(`/inventory/lots?companyId=${companyId}`).catch(() => []), [companyId]);
  const [f, setF] = useState({ customerId: "", kind: "complaint", priority: "normal", subject: "", description: "", lotId: "", openNcr: false });
  const save = async () => {
    try { const r = await api.post("/crm/tickets", { companyId, ...f, lotId: f.lotId || undefined, description: f.description || undefined }); toast(`${t.savedOk} — ${r.number}`); onClose(); }
    catch (e) { toast(errMsg(e, lang), true); }
  };
  return <Modal title={tt("تذكرة جديدة", "New ticket")} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t.cancel}</button><button className="btn primary" onClick={save}>{t.save}</button></>}>
    <div className="form-grid">
      <Field label={tt("العميل", "Customer")}><select value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value })}><option value="">…</option>
        {(custs.data?.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.code} · {c.name_ar}</option>)}</select></Field>
      <Field label={tt("النوع", "Kind")}><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{["complaint", "inquiry", "service", "suggestion"].map((k) => <option key={k} value={k}>{L.kind(k)}</option>)}</select></Field>
      <Field label={tt("الأولوية", "Priority")}><select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
        <option value="critical">{tt("حرج (4 ساعات)", "Critical (4 h)")}</option><option value="high">{tt("عالٍ (24 ساعة)", "High (24 h)")}</option>
        <option value="normal">{tt("عادي (3 أيام)", "Normal (3 days)")}</option><option value="low">{tt("منخفض (7 أيام)", "Low (7 days)")}</option></select></Field>
      <Field label={tt("الموضوع", "Subject")}><input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
      {f.kind === "complaint" && <Field label={tt("التشغيلة (للشكوى على منتج)", "Lot (product complaint)")}><select value={f.lotId} onChange={(e) => setF({ ...f, lotId: e.target.value })}><option value="">—</option>
        {(lots.data ?? []).map((l: any) => <option key={l.id} value={l.id}>{l.item_code} · {l.lot_no}</option>)}</select></Field>}
    </div>
    <Field label={tt("الوصف", "Description")}><textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
    {f.lotId && me?.modules.includes("quality") && <label className="row"><input type="checkbox" style={{ width: "auto" }} checked={f.openNcr} onChange={(e) => setF({ ...f, openNcr: e.target.checked })} />
      {tt("فتح حالة عدم مطابقة لدى الجودة (قرار إيقاف التشغيلة للجودة)", "Open a quality non-conformance (holding the lot is Quality's decision)")}</label>}
  </Modal>;
}

export function CrmMyActivities() {
  const { t, tt, lang } = useI18n();
  const { can, companyId } = useSession();
  const { toast } = useToast();
  const list = useAsync(() => api.get(`/crm/activities?companyId=${companyId}&mine=true&open=true`), [companyId]);
  const [f, setF] = useState({ kind: "call", subject: "", dueAt: "" });
  const add = async () => {
    try { await api.post("/crm/activities", { companyId, kind: f.kind, subject: f.subject, dueAt: f.dueAt ? new Date(f.dueAt).toISOString() : undefined }); setF({ ...f, subject: "" }); list.reload(); }
    catch (e) { toast(errMsg(e, lang), true); }
  };
  const kinds: Record<string, string> = { call: tt("اتصال", "Call"), meeting: tt("اجتماع", "Meeting"), visit: tt("زيارة", "Visit"), task: tt("مهمة", "Task"), email: tt("بريد", "Email"), note: tt("ملاحظة", "Note") };
  return <>
    <div className="page-head"><h1>{tt("أنشطتي ومتابعاتي", "My activities & follow-ups")}</h1></div>
    {can("crm.manage") && <div className="row card" style={{ marginBottom: 12, flexWrap: "wrap" }}>
      <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} style={{ width: "auto" }}>{Object.entries(kinds).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      <input placeholder={tt("الموضوع", "Subject")} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} style={{ flex: 1, minWidth: 180 }} />
      <input type="datetime-local" value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} style={{ width: "auto" }} />
      <button className="btn primary" onClick={add} disabled={!f.subject}>{t.add}</button></div>}
    {list.loading ? <Loading /> : !list.data?.length ? <div className="card"><Empty text={tt("لا توجد متابعات مفتوحة", "No open follow-ups")} /></div> : <LinesTable rows={list.data} cols={[
      { h: tt("النوع", "Kind"), v: (a) => kinds[a.kind] }, { h: tt("الموضوع", "Subject"), v: (a) => a.subject },
      { h: tt("الموعد", "Due"), v: (a) => <span className={a.overdue ? "badge bad" : ""}>{a.due_at ? fmtDateTime(a.due_at) : "—"}</span> },
      { h: "", v: (a) => <button className="btn" onClick={async () => { await api.post(`/crm/activities/${a.id}/done`, {}); list.reload(); }}>✓ {tt("تم", "Done")}</button> }]} />}
    <p style={{ color: "var(--muted)", fontSize: 12 }}>{fmtDate(new Date().toISOString())}</p>
  </>;
}
