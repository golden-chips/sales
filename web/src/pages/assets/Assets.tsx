import { useState } from "react";
import { api, fmt, fmtDate } from "../../api";
import { useI18n } from "../../i18n";
import { useSession } from "../../session";
import { Empty, ErrorBox, Field, Loading, Modal, StatusBadge, errMsg, useAsync, useToast } from "../../ui";
import { LinesTable, today, useLookups } from "../erp/shared";

const KINDS = ["machine", "equipment", "vehicle", "building", "furniture", "it", "other"] as const;
function useKindLabel() {
  const { tt } = useI18n();
  return (k: string) => ({ machine: tt("آلة", "Machine"), equipment: tt("معدة", "Equipment"), vehicle: tt("مركبة", "Vehicle"), building: tt("مبنى", "Building"),
    furniture: tt("أثاث", "Furniture"), it: tt("أجهزة حاسوب", "IT"), other: tt("أخرى", "Other") }[k] ?? k);
}

/** postable accounts of the company, optionally limited to some types */
function useAccounts(types?: string[]) {
  const { companyId } = useSession();
  const a = useAsync(() => api.get(`/accounting/accounts?companyId=${companyId}`), [companyId]);
  return (a.data ?? []).filter((x: any) => x.is_postable && x.is_active && (!types || types.includes(x.type)));
}
function AccountSelect({ value, onChange, types, optional }: { value: string; onChange: (v: string) => void; types?: string[]; optional?: boolean }) {
  const accs = useAccounts(types);
  const { pick } = useI18n();
  return <select value={value} onChange={(e) => onChange(e.target.value)}><option value="">{optional ? "—" : "…"}</option>
    {accs.map((a: any) => <option key={a.id} value={a.id}>{a.code} · {pick(a.name_ar, a.name_en)}</option>)}</select>;
}

// ================================================================== register
export function AssetRegister() {
  const { t, tt } = useI18n();
  const { can, companyId } = useSession();
  const kind = useKindLabel();
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [cats, setCats] = useState(false);
  const list = useAsync(() => api.get(`/assets?companyId=${companyId}${status ? `&status=${status}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`), [companyId, status, q]);
  const totals = (list.data ?? []).filter((a: any) => a.status === "active").reduce((s: any, a: any) => ({ cost: s.cost + Number(a.cost), book: s.book + Number(a.book_value) }), { cost: 0, book: 0 });
  return <>
    <div className="page-head"><h1>{tt("سجل الأصول الثابتة", "Fixed asset register")}</h1><div className="row">
      <input type="search" placeholder={tt("رمز، اسم أو رقم تسلسلي", "Code, name or serial")} value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />
      <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: "auto" }}><option value="">{t.status}: *</option>
        <option value="draft">{t.draft}</option><option value="active">{tt("مرسمل", "Active")}</option><option value="disposed">{tt("مستبعد", "Disposed")}</option></select>
      {can("assets.register.manage") && <button className="btn" onClick={() => setCats(true)}>{tt("الفئات", "Categories")}</button>}
      {can("assets.register.manage") && <button className="btn primary" onClick={() => setCreating(true)}>{tt("أصل جديد", "New asset")}</button>}</div></div>
    <div className="kpis"><div className="kpi"><div className="label">{tt("تكلفة الأصول القائمة", "Cost of active assets")}</div><div className="value num">{fmt(totals.cost)}</div></div>
      <div className="kpi"><div className="label">{tt("القيمة الدفترية", "Book value")}</div><div className="value num">{fmt(totals.book)}</div></div></div>
    <ErrorBox error={list.error} />
    {list.loading ? <Loading /> : !list.data?.length ? <div className="card"><Empty /></div> : <div className="table-wrap"><table>
      <thead><tr><th>{t.code}</th><th>{t.name}</th><th>{tt("النوع", "Kind")}</th><th>{tt("الفئة", "Category")}</th><th>{tt("الموقع", "Location")}</th>
        <th className="end">{tt("التكلفة", "Cost")}</th><th className="end">{tt("مجمع الإهلاك", "Accumulated")}</th><th className="end">{tt("القيمة الدفترية", "Book value")}</th>
        <th>{tt("الصيانة القادمة", "Next maintenance")}</th><th>{t.status}</th></tr></thead>
      <tbody>{list.data.map((a: any) => <tr key={a.id} style={{ cursor: "pointer" }} onClick={() => setOpenId(a.id)}>
        <td className="num">{a.code}</td><td>{a.name_ar}</td><td>{kind(a.kind)}</td><td>{a.category_name_ar}</td><td>{a.location ?? "—"}</td>
        <td className="end num">{fmt(a.cost)}</td><td className="end num">{fmt(a.accumulated_depreciation)}</td><td className="end num">{fmt(a.book_value)}</td>
        <td className="num">{fmtDate(a.next_maintenance)}{a.open_orders ? <span className="badge warn" style={{ marginInlineStart: 4 }}>{a.open_orders}</span> : null}</td>
        <td><StatusBadge s={a.status} /></td></tr>)}</tbody>
    </table></div>}
    {creating && <NewAsset onClose={() => { setCreating(false); list.reload(); }} />}
    {cats && <Categories onClose={() => setCats(false)} />}
    {openId && <AssetCard id={openId} onClose={() => { setOpenId(null); list.reload(); }} />}
  </>;
}

function Categories({ onClose }: { onClose: () => void }) {
  const { t, tt, lang } = useI18n();
  const { companyId } = useSession();
  const { toast } = useToast();
  const list = useAsync(() => api.get(`/assets/categories?companyId=${companyId}`), [companyId]);
  const [f, setF] = useState({ code: "", nameAr: "", method: "straight_line", usefulLifeMonths: "60", residualPct: "0", assetAccountId: "", accumAccountId: "", expenseAccountId: "", maintenanceAccountId: "" });
  const [err, setErr] = useState<unknown>(null);
  const save = async () => {
    setErr(null);
    try {
      await api.post("/assets/categories", { companyId, ...f, usefulLifeMonths: Number(f.usefulLifeMonths), maintenanceAccountId: f.maintenanceAccountId || null });
      toast(t.savedOk); list.reload(); setF({ ...f, code: "", nameAr: "" });
    } catch (e) { setErr(e); toast(errMsg(e, lang), true); }
  };
  return <Modal title={tt("فئات الأصول", "Asset categories")} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t.close}</button><button className="btn primary" onClick={save}>{t.add}</button></>}>
    {list.data?.length ? <LinesTable rows={list.data} cols={[{ h: t.code, v: (c) => c.code }, { h: t.name, v: (c) => c.name_ar },
      { h: tt("الطريقة", "Method"), v: (c) => c.method === "straight_line" ? tt("قسط ثابت", "Straight line") : tt("متناقص", "Declining") },
      { h: tt("العمر (شهر)", "Life (months)"), v: (c) => c.useful_life_months, end: true },
      { h: tt("الحسابات", "Accounts"), v: (c) => `${c.asset_account_code} / ${c.accum_account_code} / ${c.expense_account_code}${c.maintenance_account_code ? ` / ${c.maintenance_account_code}` : ""}` }]} /> : null}
    <ErrorBox error={err} />
    <div className="form-grid" style={{ marginTop: 12 }}>
      <Field label={t.code}><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
      <Field label={t.name}><input value={f.nameAr} onChange={(e) => setF({ ...f, nameAr: e.target.value })} /></Field>
      <Field label={tt("طريقة الإهلاك", "Method")}><select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
        <option value="straight_line">{tt("قسط ثابت", "Straight line")}</option><option value="declining_balance">{tt("متناقص مضاعف", "Double declining")}</option></select></Field>
      <Field label={tt("العمر الإنتاجي (شهر)", "Useful life (months)")}><input className="num" value={f.usefulLifeMonths} onChange={(e) => setF({ ...f, usefulLifeMonths: e.target.value })} /></Field>
      <Field label={tt("نسبة الخردة %", "Residual %")}><input className="num" value={f.residualPct} onChange={(e) => setF({ ...f, residualPct: e.target.value })} /></Field>
      <Field label={tt("حساب الأصل", "Asset account")}><AccountSelect value={f.assetAccountId} onChange={(v) => setF({ ...f, assetAccountId: v })} types={["asset"]} /></Field>
      <Field label={tt("حساب مجمع الإهلاك", "Accumulated depreciation")}><AccountSelect value={f.accumAccountId} onChange={(v) => setF({ ...f, accumAccountId: v })} types={["asset"]} /></Field>
      <Field label={tt("مصروف الإهلاك", "Depreciation expense")}><AccountSelect value={f.expenseAccountId} onChange={(v) => setF({ ...f, expenseAccountId: v })} types={["expense"]} /></Field>
      <Field label={tt("مصروف الصيانة", "Maintenance expense")}><AccountSelect value={f.maintenanceAccountId} onChange={(v) => setF({ ...f, maintenanceAccountId: v })} types={["expense"]} optional /></Field>
    </div>
  </Modal>;
}

function NewAsset({ onClose }: { onClose: () => void }) {
  const { t, tt, lang } = useI18n();
  const { companyId } = useSession();
  const { toast } = useToast();
  const kindL = useKindLabel();
  const cats = useAsync(() => api.get(`/assets/categories?companyId=${companyId}`), [companyId]);
  const [opening, setOpening] = useState(false);
  const [f, setF] = useState({ categoryId: "", code: "", nameAr: "", kind: "machine", serialNo: "", location: "", acquisitionDate: today(), inServiceDate: "", cost: "", residualValue: "",
    fundingAccountId: "", openingAccumulated: "", openingMonthsUsed: "" });
  const [err, setErr] = useState<unknown>(null);
  const save = async () => {
    setErr(null);
    try {
      await api.post("/assets", { companyId, categoryId: f.categoryId, code: f.code, nameAr: f.nameAr, kind: f.kind, serialNo: f.serialNo || undefined, location: f.location || undefined,
        acquisitionDate: f.acquisitionDate, inServiceDate: f.inServiceDate || undefined, cost: f.cost, residualValue: f.residualValue || undefined, fundingAccountId: f.fundingAccountId || null,
        ...(opening ? { openingAccumulated: f.openingAccumulated || "0", openingMonthsUsed: Number(f.openingMonthsUsed || 0) } : {}) });
      toast(t.savedOk); onClose();
    } catch (e) { setErr(e); toast(errMsg(e, lang), true); }
  };
  return <Modal title={tt("بطاقة أصل جديدة (مسودة)", "New asset card (draft)")} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t.cancel}</button><button className="btn primary" onClick={save}>{t.save}</button></>}>
    <div className="alert info">{tt("تُحفظ البطاقة مسودة، ثم يرسملها مستخدم آخر لديه صلاحية الرسملة فيُرحَّل قيدها. يبدأ الإهلاك من الشهر التالي لتاريخ بدء الاستخدام.",
      "The card is saved as a draft; another user with capitalization rights posts it. Depreciation starts the month after the in-service date.")}</div>
    {!cats.loading && !cats.data?.length && <div className="alert warn">{tt("عرّف فئة أصول أولًا (زر الفئات).", "Define an asset category first (Categories button).")}</div>}
    <ErrorBox error={err} />
    <div className="form-grid">
      <Field label={tt("الفئة", "Category")}><select value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}><option value="">…</option>
        {cats.data?.map((c: any) => <option key={c.id} value={c.id}>{c.code} · {c.name_ar}</option>)}</select></Field>
      <Field label={t.code}><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
      <Field label={t.name}><input value={f.nameAr} onChange={(e) => setF({ ...f, nameAr: e.target.value })} /></Field>
      <Field label={tt("النوع", "Kind")}><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{KINDS.map((k) => <option key={k} value={k}>{kindL(k)}</option>)}</select></Field>
      <Field label={tt("الرقم التسلسلي", "Serial no.")}><input value={f.serialNo} onChange={(e) => setF({ ...f, serialNo: e.target.value })} /></Field>
      <Field label={tt("الموقع", "Location")}><input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></Field>
      <Field label={tt("تاريخ الاقتناء", "Acquisition date")}><input type="date" value={f.acquisitionDate} onChange={(e) => setF({ ...f, acquisitionDate: e.target.value })} /></Field>
      <Field label={tt("بدء الاستخدام", "In service")}><input type="date" value={f.inServiceDate} onChange={(e) => setF({ ...f, inServiceDate: e.target.value })} /></Field>
      <Field label={tt("التكلفة", "Cost")}><input className="num" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} /></Field>
      <Field label={tt("قيمة الخردة (اختياري)", "Residual (optional)")}><input className="num" value={f.residualValue} onChange={(e) => setF({ ...f, residualValue: e.target.value })} /></Field>
      <Field label={tt("الحساب الدائن (بنك، خزينة، أرصدة افتتاحية…)", "Credit account (bank, cash, opening balance…)")}><AccountSelect value={f.fundingAccountId} onChange={(v) => setF({ ...f, fundingAccountId: v })} optional /></Field>
    </div>
    <label className="row" style={{ marginTop: 8 }}><input type="checkbox" checked={opening} onChange={(e) => setOpening(e.target.checked)} style={{ width: "auto" }} />
      {tt("أصل مستخدم قبل النظام (رصيد افتتاحي بإهلاك متراكم)", "Asset in use before the system (opening accumulated depreciation)")}</label>
    {opening && <div className="form-grid">
      <Field label={tt("الإهلاك المتراكم حتى الآن", "Accumulated so far")}><input className="num" value={f.openingAccumulated} onChange={(e) => setF({ ...f, openingAccumulated: e.target.value })} /></Field>
      <Field label={tt("الأشهر المستهلكة", "Months used")}><input className="num" value={f.openingMonthsUsed} onChange={(e) => setF({ ...f, openingMonthsUsed: e.target.value })} /></Field></div>}
  </Modal>;
}

function AssetCard({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, tt, lang } = useI18n();
  const { can, me } = useSession();
  const { toast } = useToast();
  const d = useAsync(() => api.get(`/assets/${id}`), [id]);
  const [disposing, setDisposing] = useState(false);
  const a = d.data?.asset;
  const capitalize = async () => {
    try { await api.post(`/assets/${id}/capitalize`, {}, { idempotencyKey: `cap-${id}` }); toast(t.postedOk); d.reload(); } catch (e) { toast(errMsg(e, lang), true); }
  };
  return <Modal title={a ? `${a.code} — ${a.name_ar}` : "…"} onClose={onClose} footer={<>
    <button className="btn" onClick={onClose}>{t.close}</button>
    {a?.status === "draft" && can("assets.register.capitalize") && <button className="btn primary" disabled={a.created_by === me?.user.id} title={a.created_by === me?.user.id ? tt("فصل المهام: رسملة بواسطة مستخدم آخر", "SoD: another user capitalizes") : ""} onClick={capitalize}>{tt("رسملة وترحيل", "Capitalize & post")}</button>}
    {a?.status === "active" && can("assets.register.dispose") && <button className="btn danger" onClick={() => setDisposing(true)}>{tt("استبعاد / بيع", "Dispose / sell")}</button>}</>}>
    <ErrorBox error={d.error} />
    {!a ? <Loading /> : <>
      <div className="kpis">
        <div className="kpi"><div className="label">{tt("التكلفة", "Cost")}</div><div className="value num">{fmt(a.cost)}</div></div>
        <div className="kpi"><div className="label">{tt("مجمع الإهلاك", "Accumulated")}</div><div className="value num">{fmt(a.accumulated_depreciation)}</div></div>
        <div className="kpi"><div className="label">{tt("القيمة الدفترية", "Book value")}</div><div className="value num">{fmt(a.book_value)}</div></div>
        <div className="kpi"><div className="label">{tt("الأشهر", "Months")}</div><div className="value num">{a.months_depreciated} / {a.useful_life_months}</div></div>
        <div className="kpi"><div className="label">{tt("الأعطال / التوقف (دقيقة)", "Breakdowns / downtime (min)")}</div><div className="value num">{d.data.totals.breakdowns} / {d.data.totals.downtime_minutes}</div></div>
        <div className="kpi"><div className="label">{tt("تكلفة الصيانة", "Maintenance cost")}</div><div className="value num">{fmt(d.data.totals.maintenance_cost)}</div></div>
      </div>
      <p><StatusBadge s={a.status} /> {a.category_name_ar} · {a.method === "straight_line" ? tt("قسط ثابت", "Straight line") : tt("متناقص مضاعف", "Double declining")} · {tt("بدء الاستخدام", "In service")} {fmtDate(a.in_service_date)}
        {a.serial_no ? ` · S/N ${a.serial_no}` : ""}{a.location ? ` · ${a.location}` : ""}{a.status === "disposed" ? ` · ${tt("استُبعد", "Disposed")} ${fmtDate(a.disposal_date)} (${fmt(a.disposal_proceeds)})` : ""}</p>
      <h3>{tt("سجل الإهلاك", "Depreciation history")}</h3>
      {d.data.depreciation.length ? <LinesTable rows={d.data.depreciation} cols={[{ h: tt("الشهر", "Month"), v: (l) => String(l.period).slice(0, 7) },
        { h: tt("القسط", "Amount"), v: (l) => fmt(l.amount), end: true }, { h: tt("المتراكم", "Accumulated"), v: (l) => fmt(l.accumulated_after), end: true },
        { h: tt("الدفترية", "Book value"), v: (l) => fmt(l.book_value_after), end: true }, { h: t.status, v: (l) => <StatusBadge s={l.status} /> }]} /> : <Empty />}
      <h3>{tt("سجل الصيانة", "Maintenance history")}</h3>
      {d.data.maintenance.length ? <LinesTable rows={d.data.maintenance} cols={[{ h: t.number, v: (o) => o.number }, { h: tt("النوع", "Kind"), v: (o) => o.kind === "preventive" ? tt("وقائية", "Preventive") : tt("عطل", "Breakdown") },
        { h: tt("الوصف", "Description"), v: (o) => o.description }, { h: tt("التوقف (دقيقة)", "Downtime (min)"), v: (o) => o.downtime_minutes, end: true }, { h: tt("التكلفة", "Cost"), v: (o) => fmt(o.total_cost), end: true },
        { h: t.status, v: (o) => <StatusBadge s={o.status} /> }]} /> : <Empty />}
    </>}
    {disposing && a && <Dispose asset={a} onClose={() => { setDisposing(false); d.reload(); }} />}
  </Modal>;
}

function Dispose({ asset, onClose }: { asset: any; onClose: () => void }) {
  const { t, tt, lang } = useI18n();
  const { toast } = useToast();
  const [f, setF] = useState({ date: today(), proceeds: "0", proceedsAccountId: "", gainLossAccountId: "", reason: "" });
  const [err, setErr] = useState<unknown>(null);
  const diff = Number(asset.book_value) - Number(f.proceeds || 0);
  const save = async () => {
    setErr(null);
    try {
      await api.post(`/assets/${asset.id}/dispose`, { ...f, proceedsAccountId: f.proceedsAccountId || null, gainLossAccountId: f.gainLossAccountId || null }, { idempotencyKey: `dispose-${asset.id}` });
      toast(t.postedOk); onClose();
    } catch (e) { setErr(e); toast(errMsg(e, lang), true); }
  };
  return <Modal title={`${tt("استبعاد", "Dispose of")} ${asset.code}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t.cancel}</button><button className="btn danger" onClick={save}>{tt("ترحيل الاستبعاد", "Post disposal")}</button></>}>
    <div className="alert info">{tt("يجب ترحيل الإهلاك حتى الشهر السابق للاستبعاد. القيمة الدفترية الحالية:", "Depreciation must be posted up to the month before disposal. Current book value:")} <b className="num">{fmt(asset.book_value)}</b>
      {" — "}{diff > 0 ? `${tt("خسارة", "Loss")} ${fmt(diff)}` : diff < 0 ? `${tt("ربح", "Gain")} ${fmt(-diff)}` : tt("بدون ربح أو خسارة", "No gain or loss")}</div>
    <ErrorBox error={err} />
    <div className="form-grid">
      <Field label={t.date}><input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
      <Field label={tt("متحصلات البيع", "Proceeds")}><input className="num" value={f.proceeds} onChange={(e) => setF({ ...f, proceeds: e.target.value })} /></Field>
      <Field label={tt("حساب المتحصلات (خزينة/بنك)", "Proceeds account (cash/bank)")}><AccountSelect value={f.proceedsAccountId} onChange={(v) => setF({ ...f, proceedsAccountId: v })} types={["asset"]} optional /></Field>
      <Field label={tt("حساب الربح/الخسارة", "Gain/loss account")}><AccountSelect value={f.gainLossAccountId} onChange={(v) => setF({ ...f, gainLossAccountId: v })} types={["revenue", "expense"]} optional /></Field>
      <Field label={tt("السبب", "Reason")}><input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
    </div>
  </Modal>;
}

// ================================================================== depreciation
export function Depreciation() {
  const { t, tt, lang } = useI18n();
  const { can, companyId, me } = useSession();
  const { toast, confirm } = useToast();
  const [period, setPeriod] = useState(today().slice(0, 7));
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useAsync(() => api.get(`/assets/depreciation-runs?companyId=${companyId}`), [companyId]);
  const run = useAsync(() => (openId ? api.get(`/assets/depreciation-runs/${openId}`) : Promise.resolve(null)), [openId]);
  const prepare = async () => {
    try { const r = await api.post("/assets/depreciation-runs", { companyId, period: `${period}-01` }); setOpenId(r.id); list.reload(); } catch (e) { toast(errMsg(e, lang), true); }
  };
  const post = async () => {
    try { await api.post(`/assets/depreciation-runs/${openId}/post`, {}, { idempotencyKey: `dep-${openId}` }); toast(t.postedOk); run.reload(); list.reload(); } catch (e) { toast(errMsg(e, lang), true); }
  };
  const del = async () => {
    if (!(await confirm(`${t.delete}?`))) return;
    try { await api.del(`/assets/depreciation-runs/${openId}`); setOpenId(null); list.reload(); } catch (e) { toast(errMsg(e, lang), true); }
  };
  return <>
    <div className="page-head"><h1>{tt("الإهلاك الشهري", "Monthly depreciation")}</h1>{can("assets.depreciation.prepare") && <div className="row">
      <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} style={{ width: "auto" }} />
      <button className="btn primary" onClick={prepare}>{tt("إعداد الدورة", "Prepare run")}</button></div>}</div>
    <div className="alert info">{tt("الدورات متتالية: لا يمكن تخطي شهر ولا إهلاك شهر مرتين. يُعدّ الدورة مستخدم ويرحّلها آخر.", "Runs are sequential: no month can be skipped or depreciated twice. One user prepares, another posts.")}</div>
    <ErrorBox error={list.error} />
    {list.loading ? <Loading /> : !list.data?.length ? <div className="card"><Empty /></div> : <div className="table-wrap"><table>
      <thead><tr><th>{tt("الشهر", "Month")}</th><th>{t.number}</th><th className="end">{tt("الأصول", "Assets")}</th><th className="end">{t.total}</th><th>{t.status}</th></tr></thead>
      <tbody>{list.data.map((r: any) => <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => setOpenId(r.id)}><td className="num">{String(r.period).slice(0, 7)}</td><td className="num">{r.number ?? "—"}</td>
        <td className="end num">{r.assets}</td><td className="end num">{fmt(r.total)}</td><td><StatusBadge s={r.status} /></td></tr>)}</tbody></table></div>}
    {openId && run.data && <Modal title={`${tt("إهلاك", "Depreciation")} ${String(run.data.period).slice(0, 7)}`} onClose={() => setOpenId(null)} footer={<>
      <button className="btn" onClick={() => setOpenId(null)}>{t.close}</button>
      {run.data.status === "draft" && can("assets.depreciation.prepare") && <button className="btn" onClick={del}>{t.delete}</button>}
      {run.data.status === "draft" && can("assets.depreciation.post") && <button className="btn primary" disabled={run.data.created_by === me?.user.id} onClick={post}>{t.post}</button>}</>}>
      {run.data.lines.length ? <LinesTable rows={run.data.lines} cols={[{ h: t.code, v: (l) => l.code }, { h: t.name, v: (l) => l.name_ar }, { h: tt("الفئة", "Category"), v: (l) => l.category_code },
        { h: tt("القسط", "Amount"), v: (l) => fmt(l.amount), end: true }, { h: tt("المتراكم بعده", "Accumulated after"), v: (l) => fmt(l.accumulated_after), end: true },
        { h: tt("الدفترية بعده", "Book value after"), v: (l) => fmt(l.book_value_after), end: true }]} /> : <Empty text={tt("لا توجد أصول مستحقة الإهلاك لهذا الشهر", "No assets to depreciate this month")} />}
      <p className="num"><b>{t.total}: {fmt(run.data.total)}</b></p>
    </Modal>}
  </>;
}

// ================================================================== maintenance
export function Maintenance() {
  const { t, tt, lang } = useI18n();
  const { can, companyId } = useSession();
  const { toast } = useToast();
  const [tab, setTab] = useState<"orders" | "plans" | "summary">("orders");
  const [status, setStatus] = useState("open");
  const [openId, setOpenId] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const [planning, setPlanning] = useState(false);
  const orders = useAsync(() => api.get(`/maintenance/orders?companyId=${companyId}${status ? `&status=${status}` : ""}`), [companyId, status]);
  const plans = useAsync(() => api.get(`/maintenance/plans?companyId=${companyId}`), [companyId]);
  const year = today().slice(0, 4);
  const summary = useAsync(() => (tab === "summary" ? api.get(`/maintenance/summary?companyId=${companyId}&from=${year}-01-01&to=${today()}`) : Promise.resolve(null)), [companyId, tab]);
  const generate = async () => {
    try { const r = await api.post("/maintenance/plans/generate", { companyId, asOf: today() }); toast(`${tt("أوامر وقائية جديدة", "New preventive orders")}: ${r.length}`); orders.reload(); } catch (e) { toast(errMsg(e, lang), true); }
  };
  const prio = (p: string) => <span className={`badge ${p === "critical" || p === "high" ? "bad" : p === "normal" ? "" : "ok"}`}>{({ critical: tt("حرج", "Critical"), high: tt("عالٍ", "High"), normal: tt("عادي", "Normal"), low: tt("منخفض", "Low") } as any)[p]}</span>;
  return <>
    <div className="page-head"><h1>{tt("الصيانة", "Maintenance")}</h1><div className="row">
      <div className="row">{(["orders", "plans", "summary"] as const).map((k) => <button key={k} className={`btn ${tab === k ? "primary" : ""}`} onClick={() => setTab(k)}>
        {{ orders: tt("أوامر العمل", "Work orders"), plans: tt("الخطط الوقائية", "Preventive plans"), summary: tt("الاعتمادية والتكلفة", "Reliability & cost") }[k]}</button>)}</div>
      {can("assets.maintenance.manage") && <><button className="btn" onClick={generate}>{tt("توليد المستحق", "Generate due")}</button>
        <button className="btn danger" onClick={() => setReporting(true)}>{tt("بلاغ عطل", "Report breakdown")}</button></>}</div></div>
    {tab === "orders" && <>
      <div className="row" style={{ marginBottom: 8 }}><select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: "auto" }}><option value="">{t.status}: *</option>
        <option value="open">{tt("مفتوح", "Open")}</option><option value="in_progress">{tt("قيد التنفيذ", "In progress")}</option><option value="completed">{tt("مكتمل", "Completed")}</option><option value="cancelled">{tt("ملغى", "Cancelled")}</option></select></div>
      <ErrorBox error={orders.error} />
      {orders.loading ? <Loading /> : !orders.data?.length ? <div className="card"><Empty /></div> : <div className="table-wrap"><table>
        <thead><tr><th>{t.number}</th><th>{tt("الأصل", "Asset")}</th><th>{tt("النوع", "Kind")}</th><th>{tt("الأولوية", "Priority")}</th><th>{tt("الوصف", "Description")}</th><th>{tt("الإبلاغ", "Reported")}</th><th className="end">{tt("التكلفة", "Cost")}</th><th>{t.status}</th></tr></thead>
        <tbody>{orders.data.map((o: any) => <tr key={o.id} style={{ cursor: "pointer" }} onClick={() => setOpenId(o.id)}><td className="num">{o.number}</td><td>{o.asset_code} · {o.asset_name_ar}</td>
          <td>{o.kind === "preventive" ? tt("وقائية", "Preventive") : tt("عطل", "Breakdown")}</td><td>{prio(o.priority)}</td><td style={{ whiteSpace: "normal", maxWidth: 320 }}>{o.description}</td>
          <td className="num">{fmtDate(o.reported_at)}</td><td className="end num">{o.status === "completed" ? fmt(o.total_cost) : "—"}</td><td><StatusBadge s={o.status} /></td></tr>)}</tbody></table></div>}
    </>}
    {tab === "plans" && <>
      {can("assets.maintenance.manage") && <div className="row" style={{ marginBottom: 8 }}><button className="btn primary" onClick={() => setPlanning(true)}>{tt("خطة وقائية جديدة", "New preventive plan")}</button></div>}
      {!plans.data?.length ? <div className="card"><Empty /></div> : <LinesTable rows={plans.data} cols={[{ h: tt("الأصل", "Asset"), v: (p) => `${p.asset_code} · ${p.asset_name_ar}` }, { h: t.name, v: (p) => p.name_ar },
        { h: tt("كل (يوم)", "Every (days)"), v: (p) => p.interval_days, end: true }, { h: tt("الاستحقاق التالي", "Next due"), v: (p) => <span className={String(p.next_due_date).slice(0, 10) <= today() && p.is_active ? "badge bad" : ""}>{fmtDate(p.next_due_date)}</span> },
        { h: tt("آخر تنفيذ", "Last done"), v: (p) => fmtDate(p.last_done_date) }, { h: t.status, v: (p) => p.is_active ? tt("فعّالة", "Active") : tt("موقوفة", "Inactive") }]} />}
    </>}
    {tab === "summary" && (summary.loading ? <Loading /> : !summary.data?.length ? <div className="card"><Empty /></div> : <LinesTable rows={summary.data} cols={[
      { h: tt("الأصل", "Asset"), v: (r) => `${r.code} · ${r.name_ar}` }, { h: tt("الأعطال", "Breakdowns"), v: (r) => r.breakdowns, end: true }, { h: tt("وقائية منفذة", "Preventive done"), v: (r) => r.preventive_done, end: true },
      { h: tt("التوقف (ساعة)", "Downtime (h)"), v: (r) => (r.downtime_minutes / 60).toFixed(1), end: true }, { h: tt("متوسط الأيام بين الأعطال", "MTBF (days)"), v: (r) => r.mtbf_days ?? "—", end: true },
      { h: tt("تكلفة الصيانة", "Maintenance cost"), v: (r) => fmt(r.maintenance_cost), end: true }, { h: tt("الإهلاك", "Depreciation"), v: (r) => fmt(r.depreciation), end: true }]} />)}
    {reporting && <ReportBreakdown onClose={() => { setReporting(false); orders.reload(); }} />}
    {planning && <NewPlan onClose={() => { setPlanning(false); plans.reload(); }} />}
    {openId && <WorkOrder id={openId} onClose={() => { setOpenId(null); orders.reload(); plans.reload(); }} />}
  </>;
}

function useActiveAssets() {
  const { companyId } = useSession();
  return useAsync(() => api.get(`/assets?companyId=${companyId}&status=active`), [companyId]).data ?? [];
}

function ReportBreakdown({ onClose }: { onClose: () => void }) {
  const { t, tt, lang } = useI18n();
  const { toast } = useToast();
  const assets = useActiveAssets();
  const [f, setF] = useState({ assetId: "", priority: "high", description: "", failureCode: "" });
  const [err, setErr] = useState<unknown>(null);
  const save = async () => {
    setErr(null);
    try { const r = await api.post("/maintenance/orders", { ...f, failureCode: f.failureCode || undefined }); toast(`${t.savedOk} — ${r.number}`); onClose(); } catch (e) { setErr(e); toast(errMsg(e, lang), true); }
  };
  return <Modal title={tt("بلاغ عطل (أمر صيانة تصحيحية)", "Report a breakdown (corrective order)")} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t.cancel}</button><button className="btn primary" onClick={save}>{t.save}</button></>}>
    <ErrorBox error={err} />
    <div className="form-grid">
      <Field label={tt("الأصل", "Asset")}><select value={f.assetId} onChange={(e) => setF({ ...f, assetId: e.target.value })}><option value="">…</option>{assets.map((a: any) => <option key={a.id} value={a.id}>{a.code} · {a.name_ar}</option>)}</select></Field>
      <Field label={tt("الأولوية", "Priority")}><select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
        <option value="critical">{tt("حرج — الخط متوقف", "Critical — line down")}</option><option value="high">{tt("عالٍ", "High")}</option><option value="normal">{tt("عادي", "Normal")}</option><option value="low">{tt("منخفض", "Low")}</option></select></Field>
      <Field label={tt("رمز العطل", "Failure code")}><input value={f.failureCode} onChange={(e) => setF({ ...f, failureCode: e.target.value })} /></Field>
    </div>
    <Field label={tt("الوصف", "Description")}><textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
  </Modal>;
}

function NewPlan({ onClose }: { onClose: () => void }) {
  const { t, tt, lang } = useI18n();
  const { toast } = useToast();
  const assets = useActiveAssets();
  const [f, setF] = useState({ assetId: "", nameAr: "", intervalDays: "30", firstDueDate: today(), checklist: "" });
  const [err, setErr] = useState<unknown>(null);
  const save = async () => {
    setErr(null);
    try { await api.post("/maintenance/plans", { ...f, intervalDays: Number(f.intervalDays), checklist: f.checklist || undefined }); toast(t.savedOk); onClose(); } catch (e) { setErr(e); toast(errMsg(e, lang), true); }
  };
  return <Modal title={tt("خطة صيانة وقائية", "Preventive maintenance plan")} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t.cancel}</button><button className="btn primary" onClick={save}>{t.save}</button></>}>
    <ErrorBox error={err} />
    <div className="form-grid">
      <Field label={tt("الأصل", "Asset")}><select value={f.assetId} onChange={(e) => setF({ ...f, assetId: e.target.value })}><option value="">…</option>{assets.map((a: any) => <option key={a.id} value={a.id}>{a.code} · {a.name_ar}</option>)}</select></Field>
      <Field label={t.name}><input value={f.nameAr} onChange={(e) => setF({ ...f, nameAr: e.target.value })} /></Field>
      <Field label={tt("كل (يوم)", "Every (days)")}><input className="num" value={f.intervalDays} onChange={(e) => setF({ ...f, intervalDays: e.target.value })} /></Field>
      <Field label={tt("أول استحقاق", "First due")}><input type="date" value={f.firstDueDate} onChange={(e) => setF({ ...f, firstDueDate: e.target.value })} /></Field>
    </div>
    <Field label={tt("قائمة الفحص", "Checklist")}><textarea rows={3} value={f.checklist} onChange={(e) => setF({ ...f, checklist: e.target.value })} /></Field>
  </Modal>;
}

function WorkOrder({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, tt, lang } = useI18n();
  const { can } = useSession();
  const { toast } = useToast();
  const { items, warehouses } = useLookups();
  const o = useAsync(() => api.get(`/maintenance/orders/${id}`), [id]);
  const [parts, setParts] = useState<{ itemId: string; qty: string }[] | null>(null);
  const [wh, setWh] = useState<string>("");
  const [c, setC] = useState({ completionDate: today(), downtimeMinutes: "0", externalCost: "0", externalAccountId: "", resolution: "" });
  const [err, setErr] = useState<unknown>(null);
  const d = o.data;
  const open = d && ["open", "in_progress"].includes(d.status);
  const curParts = parts ?? d?.parts.map((p: any) => ({ itemId: p.item_id, qty: String(Number(p.qty)) })) ?? [];
  const curWh = wh || d?.warehouse_id || "";
  const act = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); o.reload(); setParts(null); } catch (e) { setErr(e); toast(errMsg(e, lang), true); } };
  const saveParts = () => act(() => api.put(`/maintenance/orders/${id}/parts`, { warehouseId: curWh || null, parts: curParts.filter((p: any) => p.itemId && Number(p.qty) > 0) }));
  const complete = () => act(async () => {
    if (parts) await api.put(`/maintenance/orders/${id}/parts`, { warehouseId: curWh || null, parts: curParts.filter((p: any) => p.itemId && Number(p.qty) > 0) });
    await api.post(`/maintenance/orders/${id}/complete`, { ...c, downtimeMinutes: Number(c.downtimeMinutes), externalAccountId: c.externalAccountId || null }, { idempotencyKey: `wo-${id}-${Date.now()}` });
    toast(t.postedOk);
  });
  return <Modal title={d ? `${d.number} — ${d.asset_code}` : "…"} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t.close}</button>
    {open && d.status === "open" && can("assets.maintenance.manage") && <button className="btn" onClick={() => act(() => api.post(`/maintenance/orders/${id}/start`, {}))}>{tt("بدء العمل", "Start")}</button>}
    {open && can("assets.maintenance.manage") && <button className="btn" onClick={() => act(() => api.post(`/maintenance/orders/${id}/cancel`, { reason: tt("إلغاء من المستخدم", "Cancelled by user") }))}>{tt("إلغاء الأمر", "Cancel order")}</button>}
    {open && can("assets.maintenance.complete") && <button className="btn primary" onClick={complete}>{tt("إقفال وترحيل التكلفة", "Complete & post cost")}</button>}</>}>
    <ErrorBox error={err ?? o.error} />
    {!d ? <Loading /> : <>
      <p><StatusBadge s={d.status} /> {d.description}</p>
      <h3>{tt("قطع الغيار", "Spare parts")}</h3>
      {open ? <>
        <Field label={tt("مخزن الصرف", "Issue from warehouse")}><select value={curWh} onChange={(e) => setWh(e.target.value)}><option value="">—</option>
          {warehouses.filter((w: any) => w.kind !== "quarantine").map((w: any) => <option key={w.id} value={w.id}>{w.code} · {w.name_ar}</option>)}</select></Field>
        {curParts.map((p: any, i: number) => <div className="row" key={i} style={{ marginBottom: 4 }}>
          <select value={p.itemId} onChange={(e) => setParts(curParts.map((x: any, j: number) => j === i ? { ...x, itemId: e.target.value } : x))}><option value="">…</option>
            {items.filter((it: any) => it.kind !== "service").map((it: any) => <option key={it.id} value={it.id}>{it.code} · {it.name_ar}</option>)}</select>
          <input className="num" style={{ width: 90 }} value={p.qty} onChange={(e) => setParts(curParts.map((x: any, j: number) => j === i ? { ...x, qty: e.target.value } : x))} />
          <button className="btn" onClick={() => setParts(curParts.filter((_: any, j: number) => j !== i))}>✕</button></div>)}
        <div className="row"><button className="btn" onClick={() => setParts([...curParts, { itemId: "", qty: "1" }])}>{t.add}</button>
          {parts && <button className="btn" onClick={saveParts}>{t.save}</button>}</div>
        {can("assets.maintenance.complete") && <><h3>{tt("الإقفال", "Completion")}</h3><div className="form-grid">
          <Field label={t.date}><input type="date" value={c.completionDate} onChange={(e) => setC({ ...c, completionDate: e.target.value })} /></Field>
          <Field label={tt("مدة التوقف (دقيقة)", "Downtime (minutes)")}><input className="num" value={c.downtimeMinutes} onChange={(e) => setC({ ...c, downtimeMinutes: e.target.value })} /></Field>
          <Field label={tt("تكلفة خارجية (فني/ورشة)", "External cost (contractor)")}><input className="num" value={c.externalCost} onChange={(e) => setC({ ...c, externalCost: e.target.value })} /></Field>
          {Number(c.externalCost) > 0 && <Field label={tt("تُدفع من حساب", "Paid from account")}><AccountSelect value={c.externalAccountId} onChange={(v) => setC({ ...c, externalAccountId: v })} types={["asset", "liability"]} /></Field>}
        </div><Field label={tt("ما تم إنجازه", "Resolution")}><textarea rows={2} value={c.resolution} onChange={(e) => setC({ ...c, resolution: e.target.value })} /></Field></>}
      </> : d.parts.length ? <LinesTable rows={d.parts} cols={[{ h: tt("الصنف", "Item"), v: (p) => `${p.item_code} · ${p.item_name_ar}` }, { h: tt("الكمية", "Qty"), v: (p) => `${Number(p.qty)} ${p.uom_code}`, end: true },
        { h: tt("التكلفة", "Cost"), v: (p) => fmt(p.value), end: true }]} /> : <Empty />}
      {d.status === "completed" && <p className="num">{tt("قطع الغيار", "Parts")} {fmt(d.parts_cost)} + {tt("خارجي", "External")} {fmt(d.external_cost)} = <b>{fmt(d.total_cost)}</b> · {tt("التوقف", "Downtime")} {d.downtime_minutes} {tt("دقيقة", "min")} · {d.resolution}</p>}
    </>}
  </Modal>;
}
