import { useState } from "react";
import { api, fmt, fmtDate, fmtDateTime } from "../../api";
import { useI18n } from "../../i18n";
import { useSession } from "../../session";
import { Empty, ErrorBox, Field, Loading, Modal, errMsg, useAsync, useToast } from "../../ui";
import { LinesTable } from "../erp/shared";

const thisMonth = () => new Date().toISOString().slice(0, 7);

export function Reps() {
  const { t, tt } = useI18n();
  const { can, companyId } = useSession();
  const { toast } = useToast();
  const reps = useAsync(() => api.get(`/distribution/reps?companyId=${companyId}`), [companyId]);
  const [f, setF] = useState<any | null>(null);
  const [route, setRoute] = useState<any | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const users = useAsync(() => (f ? api.get("/users?pageSize=200") : Promise.resolve(null)), [!!f]);
  const whs = useAsync(() => api.get("/warehouses"), []);
  const terr = useAsync(() => api.get(`/distribution/territories?companyId=${companyId}`), [companyId]);
  const customers = useAsync(() => (route ? api.get(`/customers?companyId=${companyId}&pageSize=200&active=true`) : Promise.resolve(null)), [!!route]);
  const save = async () => {
    setErr(null);
    try { await api.post("/distribution/reps", { companyId, ...f, territoryId: f.territoryId || null, commissionRate: f.commissionRate || "0", maxDiscountPct: f.maxDiscountPct || "0" }); setF(null); reps.reload(); toast(t.savedOk); }
    catch (e) { setErr(e); }
  };
  const saveRoute = async () => {
    setErr(null);
    try { await api.put(`/distribution/reps/${route.rep.id}/routes`, { weekday: Number(route.weekday), name: route.name || "مسار", customerIds: route.customers }); setRoute(null); toast(t.savedOk); }
    catch (e) { setErr(e); }
  };
  const days = [tt("الأحد", "Sun"), tt("الاثنين", "Mon"), tt("الثلاثاء", "Tue"), tt("الأربعاء", "Wed"), tt("الخميس", "Thu"), tt("الجمعة", "Fri"), tt("السبت", "Sat")];
  return <>
    <div className="page-head"><h1>{tt("المناديب", "Sales reps")}</h1>{can("distribution.reps.manage") && <button className="btn primary" onClick={() => setF({ commissionType: "flat" })}>{t.add}</button>}</div>
    <ErrorBox error={reps.error} />
    {reps.loading ? <Loading /> : !reps.data?.length ? <div className="card"><Empty text={tt("سجّل مستخدمًا بدور «مندوب مبيعات» ومخزنًا من نوع «سيارة» ثم أضفه هنا", "Create a user with the sales_rep role and a 'van' warehouse, then add the rep here")} /></div> :
      <div className="table-wrap"><table>
        <thead><tr><th>{t.code}</th><th>{t.name}</th><th>{tt("السيارة", "Van")}</th><th>{tt("المنطقة", "Territory")}</th><th>{tt("العمولة", "Commission")}</th><th>{tt("أقصى خصم", "Max disc.")}</th><th className="end">{tt("العهدة", "Custody")}</th><th /></tr></thead>
        <tbody>{reps.data.map((r: any) => <tr key={r.id}><td className="num">{r.code}</td><td>{r.full_name}</td><td>{r.van_code}</td><td>{r.territory_name ?? "—"}</td>
          <td>{r.commission_type === "flat" ? `${Number(r.commission_rate)}%` : r.commission_type}</td><td className="num">{Number(r.max_discount_pct)}%</td><td className="end num">{fmt(r.custody)}</td>
          <td>{can("distribution.reps.manage") && <button className="btn sm" onClick={() => setRoute({ rep: r, weekday: new Date().getDay(), name: "", customers: [] })}>{tt("المسارات", "Routes")}</button>}</td></tr>)}</tbody>
      </table></div>}
    {f && <Modal title={tt("مندوب جديد", "New rep")} onClose={() => setF(null)} footer={<><button className="btn" onClick={() => setF(null)}>{t.cancel}</button><button className="btn primary" onClick={save}>{t.save}</button></>}>
      <ErrorBox error={err} />
      <div className="form-grid">
        <Field label={tt("المستخدم (بدور مندوب)", "User (sales_rep role)")}><select value={f.userId ?? ""} onChange={(e) => setF({ ...f, userId: e.target.value })}><option value="">—</option>
          {users.data?.data.filter((u: any) => u.roles.some((r: any) => r.code === "sales_rep")).map((u: any) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</select></Field>
        <Field label={t.code}><input dir="ltr" value={f.code ?? ""} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
        <Field label={tt("سيارة التوزيع (مخزن van)", "Van warehouse")}><select value={f.vanWarehouseId ?? ""} onChange={(e) => setF({ ...f, vanWarehouseId: e.target.value })}><option value="">—</option>
          {whs.data?.filter((w: any) => w.kind === "van").map((w: any) => <option key={w.id} value={w.id}>{w.code} {w.name_ar}</option>)}</select></Field>
        <Field label={tt("المنطقة", "Territory")}><select value={f.territoryId ?? ""} onChange={(e) => setF({ ...f, territoryId: e.target.value })}><option value="">—</option>{terr.data?.map((x: any) => <option key={x.id} value={x.id}>{x.name_ar}</option>)}</select></Field>
        <Field label={tt("العمولة", "Commission")}><select value={f.commissionType} onChange={(e) => setF({ ...f, commissionType: e.target.value })}><option value="none">—</option><option value="flat">{tt("نسبة ثابتة", "Flat %")}</option></select></Field>
        {f.commissionType === "flat" && <Field label={tt("نسبة العمولة من المحصّل %", "Rate on collections %")}><input className="num" value={f.commissionRate ?? ""} onChange={(e) => setF({ ...f, commissionRate: e.target.value })} /></Field>}
        <Field label={tt("أقصى خصم ميداني %", "Max field discount %")}><input className="num" value={f.maxDiscountPct ?? ""} onChange={(e) => setF({ ...f, maxDiscountPct: e.target.value })} /></Field>
      </div>
    </Modal>}
    {route && <Modal title={`${tt("مسار", "Route")} ${route.rep.code}`} onClose={() => setRoute(null)} footer={<><button className="btn" onClick={() => setRoute(null)}>{t.cancel}</button><button className="btn primary" onClick={saveRoute}>{t.save}</button></>}>
      <ErrorBox error={err} />
      <div className="form-grid" style={{ marginBottom: 12 }}>
        <Field label={tt("اليوم", "Day")}><select value={route.weekday} onChange={(e) => setRoute({ ...route, weekday: e.target.value })}>{days.map((d, i) => <option key={i} value={i}>{d}</option>)}</select></Field>
        <Field label={t.name}><input value={route.name} onChange={(e) => setRoute({ ...route, name: e.target.value })} /></Field>
      </div>
      <p style={{ color: "var(--muted)", fontSize: 12 }}>{tt("اختر العملاء بترتيب الزيارة:", "Pick customers in visiting order:")} {route.customers.length}</p>
      <div style={{ maxHeight: 320, overflow: "auto" }}>{customers.data?.data.map((c: any) => {
        const i = route.customers.indexOf(c.id);
        return <label key={c.id} className="row" style={{ padding: "4px 0" }}><input type="checkbox" style={{ width: "auto" }} checked={i >= 0}
          onChange={(e) => setRoute({ ...route, customers: e.target.checked ? [...route.customers, c.id] : route.customers.filter((x: string) => x !== c.id) })} />
          {i >= 0 && <span className="badge info num">{i + 1}</span>}{c.code} {c.name_ar}</label>;
      })}</div>
    </Modal>}
  </>;
}

export function Performance() {
  const { tt } = useI18n();
  const { companyId } = useSession();
  const [period, setPeriod] = useState(thisMonth());
  const d = useAsync(() => api.get(`/distribution/performance?companyId=${companyId}&period=${period}`), [companyId, period]);
  const pct = (v: number | null) => v === null ? "—" : <span className={`badge ${v >= 100 ? "ok" : v >= 70 ? "warn" : "bad"}`}>{v}%</span>;
  return <>
    <div className="page-head"><h1>{tt("أداء المناديب", "Rep performance")}</h1><input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} style={{ width: "auto" }} /></div>
    <ErrorBox error={d.error} />
    {d.loading ? <Loading /> : !d.data?.reps.length ? <div className="card"><Empty /></div> : <div className="table-wrap"><table>
      <thead><tr><th>{tt("المندوب", "Rep")}</th><th className="end">{tt("المبيعات", "Sales")}</th><th>{tt("تحقيق", "Achv.")}</th><th className="end">{tt("المحصّل", "Collected")}</th><th>{tt("تحقيق", "Achv.")}</th>
        <th className="end">{tt("الزيارات", "Visits")}</th><th>{tt("تحقيق", "Achv.")}</th><th className="end">{tt("الفواتير", "Invoices")}</th><th className="end">{tt("العهدة", "Custody")}</th><th className="end">{tt("بضاعة السيارة", "Van stock")}</th></tr></thead>
      <tbody>{d.data.reps.map((r: any) => <tr key={r.id}><td>{r.code} {r.name}</td><td className="end num">{fmt(r.sales)}</td><td>{pct(r.achievement.sales)}</td><td className="end num">{fmt(r.collected)}</td>
        <td>{pct(r.achievement.collection)}</td><td className="end num">{r.visits}</td><td>{pct(r.achievement.visits)}</td><td className="end num">{r.invoices}</td><td className="end num">{fmt(r.custody)}</td><td className="end num">{fmt(r.van_stock_value)}</td></tr>)}</tbody>
    </table></div>}
  </>;
}

export function Settlements() {
  const { t, tt, lang } = useI18n();
  const { can, companyId } = useSession();
  const { toast } = useToast();
  const [status, setStatus] = useState("submitted");
  const [open, setOpen] = useState<string | null>(null);
  const list = useAsync(() => api.get(`/distribution/settlements?companyId=${companyId}${status ? `&status=${status}` : ""}`), [companyId, status]);
  const hand = useAsync(() => api.get(`/distribution/handovers?companyId=${companyId}${status === "submitted" ? "&status=submitted" : ""}`), [companyId, status]);
  const detail = useAsync(() => (open ? api.get(`/distribution/settlements/${open}`) : Promise.resolve(null)), [open]);
  const approve = async () => { try { await api.post(`/distribution/settlements/${open}/approve`); toast(t.savedOk); detail.reload(); list.reload(); } catch (e) { toast(errMsg(e, lang), true); } };
  const confirmCash = async (h: any) => {
    const counted = prompt(`${tt("المبلغ المعدود فعليًا (المصرّح", "Counted amount (declared")} ${fmt(h.declared_amount)})`, String(Number(h.declared_amount)));
    if (!counted) return;
    try { const r = await api.post(`/distribution/handovers/${h.id}/confirm`, { countedAmount: counted }); toast(Number(r.shortage) > 0 ? `${tt("عجز", "Shortage")} ${fmt(r.shortage)}` : t.savedOk, Number(r.shortage) > 0); hand.reload(); }
    catch (e) { toast(errMsg(e, lang), true); }
  };
  return <>
    <div className="page-head"><div><h1>{tt("تسويات المناديب والعهد", "Rep settlements & cash")}</h1><p>{tt("المشرف يعتمد جرد السيارة، وأمين الصندوق يؤكد النقد. العجز يُسجّل على المندوب.", "Supervisor approves the van count; cashier confirms cash. Shortages are charged to the rep.")}</p></div>
      <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: "auto" }}><option value="submitted">{tt("بانتظار الاعتماد", "Pending")}</option><option value="approved">{tt("معتمدة", "Approved")}</option><option value="">*</option></select></div>
    <div className="card" style={{ marginBottom: 16 }}><h2>{tt("تسليم العهدة النقدية", "Cash handovers")}</h2>
      {!hand.data?.length ? <p style={{ color: "var(--muted)" }}>{t.none}</p> : <LinesTable rows={hand.data} cols={[{ h: tt("المندوب", "Rep"), v: (h) => `${h.rep_code} ${h.full_name}` }, { h: t.date, v: (h) => fmtDate(h.handover_date) },
        { h: tt("المصرّح", "Declared"), v: (h) => fmt(h.declared_amount), end: true }, { h: tt("المعدود", "Counted"), v: (h) => h.counted_amount ? fmt(h.counted_amount) : "", end: true }, { h: t.status, v: (h) => h.status },
        { h: "", v: (h) => h.status === "submitted" && can("distribution.cash.confirm") ? <button className="btn sm primary" onClick={() => confirmCash(h)}>{tt("عدّ وتأكيد", "Count & confirm")}</button> : "" }]} />}</div>
    <div className="card"><h2>{tt("جرد السيارات (تسوية اليوم)", "Van counts (day settlement)")}</h2>
      {list.loading ? <Loading /> : !list.data?.length ? <p style={{ color: "var(--muted)" }}>{t.none}</p> : <LinesTable rows={list.data} cols={[{ h: t.number, v: (s) => s.number ?? "—" },
        { h: tt("المندوب", "Rep"), v: (s) => `${s.rep_code} ${s.full_name}` }, { h: t.date, v: (s) => fmtDate(s.settlement_date) }, { h: tt("العجز", "Shortage"), v: (s) => s.shortage_value ? fmt(s.shortage_value) : "", end: true },
        { h: t.status, v: (s) => s.status }, { h: "", v: (s) => <button className="btn sm" onClick={() => setOpen(s.id)}>{t.details}</button> }]} />}</div>
    {open && <Modal title={detail.data?.number ?? tt("تسوية", "Settlement")} onClose={() => setOpen(null)} footer={detail.data?.status === "submitted" && can("distribution.settlements.approve") && <button className="btn primary" onClick={approve}>{tt("اعتماد", "Approve")}</button>}>
      {detail.loading ? <Loading /> : detail.data && <div className="grid"><LinesTable rows={detail.data.lines} cols={[{ h: tt("الصنف", "Item"), v: (l) => `${l.item_code} ${l.item_name_ar}` },
        { h: tt("الدفتري", "Book"), v: (l) => fmt(l.book_qty, 0), end: true }, { h: tt("المعدود", "Counted"), v: (l) => fmt(l.counted_qty, 0), end: true },
        { h: tt("الفرق", "Diff"), v: (l) => <b style={{ color: Number(l.diff) < 0 ? "var(--bad)" : Number(l.diff) > 0 ? "var(--warn)" : undefined }}>{fmt(l.diff, 0)}</b>, end: true }]} />
        <p>{tt("العهدة النقدية الحالية", "Current cash custody")}: <b className="num">{fmt(detail.data.custody)}</b></p></div>}
    </Modal>}
  </>;
}

export function Commissions() {
  const { t, tt, lang } = useI18n();
  const { can, companyId } = useSession();
  const { toast } = useToast();
  const [period, setPeriod] = useState(thisMonth());
  const [open, setOpen] = useState<string | null>(null);
  const runs = useAsync(() => api.get(`/distribution/commission-runs?companyId=${companyId}`), [companyId]);
  const detail = useAsync(() => (open ? api.get(`/distribution/commission-runs/${open}`) : Promise.resolve(null)), [open]);
  const run = async () => { try { const r = await api.post("/distribution/commission-runs", { companyId, period }); runs.reload(); setOpen(r.id); } catch (e) { toast(errMsg(e, lang), true); } };
  const post = async () => { try { await api.post(`/distribution/commission-runs/${open}/post`); toast(t.postedOk); detail.reload(); runs.reload(); } catch (e) { toast(errMsg(e, lang), true); } };
  return <>
    <div className="page-head"><div><h1>{tt("عمولات المناديب", "Rep commissions")}</h1><p>{tt("تُحتسب على المبالغ المحصّلة فعلًا (البيع النقدي + التحصيل)، لا على البيع الآجل.", "Calculated on money actually collected (cash sales + collections), not on credit sales.")}</p></div>
      {can("distribution.commissions.run") && <div className="row"><input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} style={{ width: "auto" }} /><button className="btn primary" onClick={run}>{tt("احتساب", "Calculate")}</button></div>}</div>
    <ErrorBox error={runs.error} />
    {!runs.data?.length ? <div className="card"><Empty /></div> : <LinesTable rows={runs.data} cols={[{ h: tt("الشهر", "Period"), v: (r) => r.period }, { h: t.total, v: (r) => fmt(r.total), end: true },
      { h: t.status, v: (r) => r.status }, { h: "", v: (r) => <button className="btn sm" onClick={() => setOpen(r.id)}>{t.details}</button> }]} />}
    {open && <Modal title={`${tt("عمولات", "Commissions")} ${detail.data?.period ?? ""}`} onClose={() => setOpen(null)} footer={detail.data?.status === "draft" && can("distribution.commissions.run") && <button className="btn primary" onClick={post}>{t.post}</button>}>
      {detail.data && <><LinesTable rows={detail.data.lines} cols={[{ h: tt("المندوب", "Rep"), v: (l) => `${l.rep_code} ${l.full_name}` }, { h: tt("المحصّل", "Collected"), v: (l) => fmt(l.collected), end: true },
        { h: tt("العمولة", "Commission"), v: (l) => fmt(l.commission), end: true }]} />{detail.data.status === "draft" && <div className="alert info" style={{ marginTop: 12 }}>{t.sodHint}</div>}</>}
    </Modal>}
  </>;
}

export function Notifications() {
  const { tt } = useI18n();
  const d = useAsync(() => api.get("/distribution/notifications"), []);
  return <>
    <div className="page-head"><div><h1>{tt("رسائل العملاء الصادرة", "Outbound customer messages")}</h1>
      <p>{tt("تُرسل عبر واتساب عند ربط القناة (حسابات Meta الحالية للشركة). حتى ذلك الحين تبقى «في الانتظار».", "Delivered via WhatsApp once the channel is connected (the company's existing Meta account). Until then they stay queued.")}</p></div></div>
    <ErrorBox error={d.error} />
    {d.loading ? <Loading /> : !d.data?.length ? <div className="card"><Empty /></div> : <LinesTable rows={d.data} cols={[{ h: "", v: (n) => fmtDateTime(n.created_at) }, { h: tt("العميل", "Customer"), v: (n) => `${n.party_code ?? ""} ${n.party_name ?? ""}` },
      { h: tt("الرقم", "Recipient"), v: (n) => <span className="num">{n.recipient}</span> }, { h: tt("القالب", "Template"), v: (n) => <code>{n.template}</code> }, { h: tt("المحتوى", "Payload"), v: (n) => <code style={{ fontSize: 11 }}>{JSON.stringify(n.payload)}</code> },
      { h: "", v: (n) => <span className={`badge ${n.status === "sent" ? "ok" : n.status === "failed" ? "bad" : "warn"}`}>{n.status}</span> }]} />}
  </>;
}
