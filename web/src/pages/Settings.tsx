// Settings: one place for every set-up screen — appearance (per user), security and controls,
// company & users, accounting, orders, POS, HR & fingerprint devices, and links to the rest.
import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Building2, Calculator, Check, ChevronLeft, ChevronRight, Fingerprint, Monitor, Moon, Palette, ScanBarcode, ShieldCheck, ShoppingCart, Sun, Wrench } from "lucide-react";
import { api, fmtDate } from "../api";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { ErrorBox, Field, Loading, errMsg, useAsync, useToast } from "../ui";
import { setAppearance, useAppearance } from "../shell";
import { PaymentMethods } from "./pos/Pos";

type Tt = (ar: string, en: string) => string;
const ACCENTS: [string, string, string, string][] = [   // code, ar, en, swatch
  ["gold", "ذهبي (هوية الشركة)", "Gold (brand)", "#C98A12"], ["royal", "أزرق ملكي", "Royal blue", "#1D4ED8"], ["emerald", "زمردي", "Emerald", "#047857"],
  ["plum", "بنفسجي", "Plum", "#6D28D9"], ["bordeaux", "عنّابي", "Bordeaux", "#9F1239"], ["slate", "رمادي هادئ", "Slate", "#334155"],
];

export default function Settings() {
  const { tt } = useI18n();
  const { can, me } = useSession();
  const [params, setParams] = useSearchParams();
  const has = (m: string) => me!.modules.includes(m);
  const tabs: { key: string; ar: string; en: string; icon: any; show: boolean }[] = [
    { key: "appearance", ar: "المظهر والألوان", en: "Appearance", icon: Palette, show: true },
    { key: "security", ar: "الأمان والضوابط", en: "Security & controls", icon: ShieldCheck, show: can("core.settings.manage") || can("core.org.view") },
    { key: "company", ar: "الشركة والمستخدمون", en: "Company & users", icon: Building2, show: can("core.org.view") || can("core.users.view") },
    { key: "accounting", ar: "المحاسبة", en: "Accounting", icon: Calculator, show: has("accounting") && can("accounting.accounts.view") },
    { key: "orders", ar: "المبيعات والمشتريات", en: "Sales & purchasing", icon: ShoppingCart, show: (has("sales") || has("purchasing")) && (can("purchasing.orders.manage") || can("purchasing.settings.manage") || can("sales.quotations.manage")) },
    { key: "pos", ar: "نقاط البيع", en: "Point of sale", icon: ScanBarcode, show: has("pos") && (can("pos.registers.manage") || can("pos.shifts.operate")) },
    { key: "hr", ar: "الموارد البشرية والبصمة", en: "HR & fingerprint", icon: Fingerprint, show: has("hr") && can("hr.employees.view") },
    { key: "more", ar: "إعدادات الأقسام الأخرى", en: "Other modules", icon: Wrench, show: true },
  ].filter((t) => t.show);
  const tab = tabs.find((t) => t.key === params.get("tab")) ?? tabs[0];
  return <>
    <div className="page-head"><div><h1>{tt("الإعدادات", "Settings")}</h1><p>{tt("كل إعدادات النظام في مكان واحد.", "Every setting in one place.")}</p></div></div>
    <div className="settings-layout">
      <nav className="card settings-nav">{tabs.map((t) => <button key={t.key} className={`role-link ${t.key === tab.key ? "active" : ""}`} onClick={() => setParams({ tab: t.key })}>
        <span className="row" style={{ gap: 10 }}><t.icon size={17} />{tt(t.ar, t.en)}</span></button>)}</nav>
      <div className="grid" style={{ gap: 16, alignContent: "start" }}>
        {tab.key === "appearance" && <AppearancePane />}
        {tab.key === "security" && <SecurityPane />}
        {tab.key === "company" && <LinksPane links={[["/organization", "الشركات والفروع والمخازن", "Companies, branches & warehouses", "core.org.view"], ["/users", "المستخدمون", "Users", "core.users.view"],
          ["/roles", "الأدوار والصلاحيات", "Roles & permissions", "core.roles.view"], ["/subscription", "الاشتراك والباقات", "Subscription & plans", "core.subscription.view"], ["/import", "استيراد البيانات من Excel", "Import from Excel", null],
          ["/go-live", "جاهزية التشغيل", "Go-live readiness", "core.golive.view"], ["/audit", "سجل التدقيق", "Audit log", "core.audit.view"]]} />}
        {tab.key === "accounting" && <AccountingPane />}
        {tab.key === "orders" && <OrdersPane />}
        {tab.key === "pos" && <><PosPane />{can("pos.registers.manage") && <PaymentMethods />}</>}
        {tab.key === "hr" && <HrPane />}
        {tab.key === "more" && <LinksPane links={[["/manufacturing/boms", "التصنيع: الوصفات وخطوط الإنتاج", "Manufacturing: formulas & lines", "manufacturing.boms.view"],
          ["/quality/specs", "الجودة: المواصفات و HACCP", "Quality: specs & HACCP", "quality.view"], ["/assets", "الأصول: فئات الأصول وحسابات الإهلاك", "Assets: categories & depreciation accounts", "assets.register.view"],
          ["/maintenance", "الصيانة: خطط الصيانة الوقائية", "Maintenance plans", "assets.maintenance.view"], ["/distribution/reps", "المناديب: المناطق والمسارات والأهداف", "Field sales: territories, routes, targets", "distribution.reps.view"],
          ["/bi", "التقارير: التنبيهات والتقارير المجدولة", "BI: alerts & scheduled reports", "bi.dashboards.view"], ["/documents", "المستندات ومسارات الاعتماد", "Documents & approvals", "documents.view"]]} />}
      </div>
    </div>
  </>;
}

function Pane({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return <div className="card"><h2 style={{ marginBottom: desc ? 4 : 12 }}>{title}</h2>{desc && <p style={{ marginTop: 0, color: "var(--muted)" }}>{desc}</p>}{children}</div>;
}

function LinksPane({ links }: { links: [string, string, string, string | null][] }) {
  const { tt, lang } = useI18n();
  const { can } = useSession();
  const Arrow = lang === "ar" ? ChevronLeft : ChevronRight;
  return <Pane title={tt("الإعدادات المرتبطة", "Related settings")}><div className="settings-links">
    {links.filter(([, , , p]) => !p || can(p)).map(([to, ar, en]) => <Link key={to} to={to} className="settings-link"><span>{tt(ar, en)}</span><Arrow size={16} /></Link>)}
  </div></Pane>;
}

// ------------------------------------------------------------------ appearance (per user)
function AppearancePane() {
  const { tt, lang, setLang } = useI18n();
  const a = useAppearance();
  const modes: [Appearance["theme"], string, string, any][] = [["light", "فاتح", "Light", Sun], ["dark", "داكن", "Dark", Moon], ["", "حسب الجهاز", "Match device", Monitor]];
  return <>
    <Pane title={tt("لون النظام", "Colour theme")} desc={tt("اختر اللون المريح لعينك — يتغير فورًا ويُحفظ لك على هذا الجهاز.", "Pick the colour you like — applies instantly and is saved for you on this device.")}>
      <div className="theme-grid">{ACCENTS.map(([code, ar, en, sw]) => <button key={code} className={`theme-swatch ${a.accent === code ? "sel" : ""}`} onClick={() => setAppearance({ accent: code })} aria-pressed={a.accent === code}>
        <span className="theme-preview" style={{ ["--sw" as any]: sw }}><span className="tp-side" /><span className="tp-body"><span className="tp-bar" /><span className="tp-btn" /></span></span>
        <span className="row" style={{ gap: 6 }}>{a.accent === code && <Check size={15} />}{tt(ar, en)}</span></button>)}</div>
    </Pane>
    <Pane title={tt("الوضع", "Mode")}>
      <div className="seg">{modes.map(([m, ar, en, Icon]) => <button key={m || "auto"} className={a.theme === m ? "on" : ""} onClick={() => setAppearance({ theme: m })}><Icon size={16} />{tt(ar, en)}</button>)}</div>
      <p style={{ color: "var(--muted)", marginBottom: 0 }}>{tt("الوضع الداكن الجديد رمادي فحمي هادئ يريح العين في الإضاءة المنخفضة، مع لون الثيم الذي اخترته.", "The dark mode is a calm charcoal that rests the eyes, with your theme colour.")}</p>
    </Pane>
    <Pane title={tt("حجم النص", "Text size")}>
      <div className="seg">{([["", "عادي", "Normal"], ["large", "كبير", "Large"], ["xlarge", "أكبر", "Larger"]] as const).map(([v, ar, en]) =>
        <button key={v || "n"} className={a.scale === v ? "on" : ""} onClick={() => setAppearance({ scale: v })}>{tt(ar, en)}</button>)}</div>
    </Pane>
    <Pane title={tt("اللغة", "Language")}>
      <div className="seg"><button className={lang === "ar" ? "on" : ""} onClick={() => setLang("ar")}>العربية</button><button className={lang === "en" ? "on" : ""} onClick={() => setLang("en")}>English</button></div>
    </Pane>
  </>;
}
type Appearance = ReturnType<typeof useAppearance>;

// ------------------------------------------------------------------ security & controls (tenant)
function SecurityPane() {
  const { tt, lang } = useI18n();
  const { can } = useSession();
  const { toast } = useToast();
  const s = useAsync(() => api.get("/settings"), []);
  const [f, setF] = useState<any>(null);
  if (s.loading) return <Loading />;
  if (s.error) return <ErrorBox error={s.error} />;
  const v = f ?? s.data;
  const edit = can("core.settings.manage");
  const save = async () => {
    try {
      await api.patch("/settings", { enforceSod: v.enforce_sod, mfaRequired: v.mfa_required, passwordMinLength: Number(v.password_min_length), sessionTtlMinutes: Number(v.session_ttl_minutes),
        maxFailedLogins: Number(v.max_failed_logins), fieldGpsRequired: v.field_gps_required, dateFormat: v.date_format });
      toast(tt("حُفظت الإعدادات", "Saved")); setF(null); s.reload();
    } catch (e) { toast(errMsg(e, lang), true); }
  };
  const set = (k: string, val: unknown) => setF({ ...v, [k]: val });
  const sw = (k: string, ar: string, en: string, hint: [string, string]) => <label className="setting-row"><span><b>{tt(ar, en)}</b><small>{tt(...hint)}</small></span>
    <input type="checkbox" className="toggle" disabled={!edit} checked={!!v[k]} onChange={(e) => set(k, e.target.checked)} /></label>;
  return <Pane title={tt("الأمان والضوابط", "Security & controls")} desc={tt("تنطبق على كل مستخدمي الشركة.", "Applies to every user of the company.")}>
    {sw("enforce_sod", "فصل المهام", "Segregation of duties", ["من ينشئ المستند لا يرحّله ولا يعتمده بنفسه — يُنصح بتفعيله دائمًا", "The creator of a document cannot post or approve it"])}
    {sw("mfa_required", "التحقق بخطوتين إلزامي", "Require two-step sign-in", ["كل مستخدم يدخل برمز من تطبيق المصادقة على جواله", "Every user signs in with an authenticator code"])}
    {sw("field_gps_required", "موقع GPS إلزامي للمناديب", "GPS required for reps", ["لا تُسجّل زيارة أو بيع ميداني بدون الموقع", "Field visits and sales need a location"])}
    <div className="form-grid" style={{ marginTop: 12 }}>
      <Field label={tt("أقل طول لكلمة المرور", "Minimum password length")}><input className="num" type="number" min={8} max={128} disabled={!edit} value={v.password_min_length} onChange={(e) => set("password_min_length", e.target.value)} /></Field>
      <Field label={tt("مدة الجلسة (دقيقة)", "Session length (minutes)")}><input className="num" type="number" min={5} max={1440} disabled={!edit} value={v.session_ttl_minutes} onChange={(e) => set("session_ttl_minutes", e.target.value)} /></Field>
      <Field label={tt("محاولات الدخول الخاطئة قبل القفل", "Failed logins before lock")}><input className="num" type="number" min={3} max={20} disabled={!edit} value={v.max_failed_logins} onChange={(e) => set("max_failed_logins", e.target.value)} /></Field>
      <Field label={tt("صيغة التاريخ", "Date format")}><select disabled={!edit} value={v.date_format} onChange={(e) => set("date_format", e.target.value)}>{["DD/MM/YYYY", "YYYY-MM-DD", "MM/DD/YYYY"].map((x) => <option key={x}>{x}</option>)}</select></Field>
    </div>
    {edit && <div className="row" style={{ marginTop: 14 }}><span className="spacer" /><button className="btn primary" disabled={!f} onClick={save}>{tt("حفظ", "Save")}</button></div>}
  </Pane>;
}

// ------------------------------------------------------------------ simple reference lists
type Col = { h: [string, string]; v: (r: any) => ReactNode };
type In = { k: string; l: [string, string]; type?: "text" | "number" | "time" | "date" | "select" | "check"; opts?: [string, string, string][]; def?: unknown; ltr?: boolean };
function RefList({ title, desc, path, cols, inputs, canAdd, extra }: { title: [string, string]; desc?: [string, string]; path: string; cols: Col[]; inputs: In[]; canAdd: boolean; extra?: (b: any) => any }) {
  const { tt, pick, lang } = useI18n();
  const { companyId } = useSession();
  const { toast } = useToast();
  const list = useAsync(() => api.get(`${path}${path.includes("?") ? "&" : "?"}companyId=${companyId}`), [companyId, path]);
  const blank = () => Object.fromEntries(inputs.map((i) => [i.k, i.def ?? (i.type === "check" ? false : "")]));
  const [f, setF] = useState<any>(blank);
  const add = async () => {
    const body: any = { companyId };
    for (const i of inputs) { const v = f[i.k]; if (v === "" || v === undefined) continue; body[i.k] = i.type === "number" ? Number(v) : v; }
    try { await api.post(path.split("?")[0], extra ? extra(body) : body); toast(tt("أُضيف", "Added")); setF(blank()); list.reload(); } catch (e) { toast(errMsg(e, lang), true); }
  };
  return <Pane title={tt(...title)} desc={desc ? tt(...desc) : undefined}>
    <ErrorBox error={list.error} />
    {list.loading ? <Loading rows={2} /> : <div className="table-wrap"><table>
      <thead><tr>{cols.map((c) => <th key={c.h[1]}>{pick(...c.h)}</th>)}</tr></thead>
      <tbody>{(list.data ?? []).length ? list.data.map((r: any, i: number) => <tr key={r.id ?? i}>{cols.map((c) => <td key={c.h[1]}>{c.v(r)}</td>)}</tr>)
        : <tr><td colSpan={cols.length} style={{ color: "var(--muted)" }}>{tt("لا يوجد بعد", "None yet")}</td></tr>}</tbody></table></div>}
    {canAdd && <div className="add-row">
      {inputs.map((i) => <Field key={i.k} label={pick(...i.l)}>{i.type === "select" ? <select value={f[i.k]} onChange={(e) => setF({ ...f, [i.k]: e.target.value })}>{i.opts!.map(([v, ar, en]) => <option key={v} value={v}>{pick(ar, en)}</option>)}</select>
        : i.type === "check" ? <input type="checkbox" className="toggle" checked={!!f[i.k]} onChange={(e) => setF({ ...f, [i.k]: e.target.checked })} />
        : <input type={i.type ?? "text"} dir={i.ltr ? "ltr" : undefined} className={i.type === "number" ? "num" : ""} value={f[i.k]} onChange={(e) => setF({ ...f, [i.k]: e.target.value })} />}</Field>)}
      <button className="btn primary" onClick={add}>{tt("إضافة", "Add")}</button>
    </div>}
  </Pane>;
}
const yes = (tt: Tt, b: boolean) => (b ? tt("نعم", "Yes") : tt("لا", "No"));

// ------------------------------------------------------------------ accounting
function AccountingPane() {
  const { tt } = useI18n();
  const { can } = useSession();
  return <>
    <LinksPane links={[["/accounts", "دليل الحسابات", "Chart of accounts", "accounting.accounts.view"], ["/periods", "السنوات المالية والفترات (فتح/إقفال)", "Fiscal years & periods", "accounting.journal.view"]]} />
    <RefList title={["مراكز التكلفة", "Cost centres"]} desc={["لتحليل المصروفات حسب القسم أو الخط أو المشروع.", "Analyse costs by department, line or project."]} path="/accounting/cost-centers" canAdd={can("accounting.cost_centers.manage")}
      cols={[{ h: ["الرمز", "Code"], v: (r) => <span className="num">{r.code}</span> }, { h: ["الاسم", "Name"], v: (r) => r.name_ar }]}
      inputs={[{ k: "code", l: ["الرمز", "Code"], ltr: true }, { k: "nameAr", l: ["الاسم", "Name"] }]} />
    <FxRates canAdd={can("accounting.fx.manage")} tt={tt} />
  </>;
}
function FxRates({ canAdd, tt }: { canAdd: boolean; tt: Tt }) {
  const { lang } = useI18n();
  const { toast } = useToast();
  const list = useAsync(() => api.get("/accounting/exchange-rates"), []);
  const [f, setF] = useState({ fromCurrency: "USD", toCurrency: "LYD", rateDate: new Date().toISOString().slice(0, 10), rate: "" });
  const add = async () => { try { await api.post("/accounting/exchange-rates", f); toast(tt("حُفظ السعر", "Saved")); list.reload(); } catch (e) { toast(errMsg(e, lang), true); } };
  return <Pane title={tt("أسعار الصرف", "Exchange rates")} desc={tt("تُستعمل للمستندات بعملة غير الدينار.", "Used for documents in foreign currencies.")}>
    {list.loading ? <Loading rows={2} /> : <div className="table-wrap"><table><thead><tr><th>{tt("التاريخ", "Date")}</th><th>{tt("من", "From")}</th><th>{tt("إلى", "To")}</th><th className="end">{tt("السعر", "Rate")}</th></tr></thead>
      <tbody>{(list.data ?? []).slice(0, 10).map((r: any) => <tr key={r.id ?? `${r.rate_date}${r.from_currency}`}><td className="num">{fmtDate(r.rate_date)}</td><td>{r.from_currency}</td><td>{r.to_currency}</td><td className="end num">{r.rate}</td></tr>)}</tbody></table></div>}
    {canAdd && <div className="add-row">
      <Field label={tt("من", "From")}><input dir="ltr" maxLength={3} value={f.fromCurrency} onChange={(e) => setF({ ...f, fromCurrency: e.target.value.toUpperCase() })} /></Field>
      <Field label={tt("إلى", "To")}><input dir="ltr" maxLength={3} value={f.toCurrency} onChange={(e) => setF({ ...f, toCurrency: e.target.value.toUpperCase() })} /></Field>
      <Field label={tt("التاريخ", "Date")}><input type="date" value={f.rateDate} onChange={(e) => setF({ ...f, rateDate: e.target.value })} /></Field>
      <Field label={tt("السعر", "Rate")}><input className="num" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} /></Field>
      <button className="btn primary" onClick={add}>{tt("حفظ", "Save")}</button></div>}
  </Pane>;
}

// ------------------------------------------------------------------ orders
function OrdersPane() {
  const { tt, lang } = useI18n();
  const { companyId, can } = useSession();
  const { toast } = useToast();
  const s = useAsync(() => api.get(`/order-settings?companyId=${companyId}`), [companyId]);
  const [f, setF] = useState<any>(null);
  if (s.loading) return <Loading />;
  if (s.error) return <ErrorBox error={s.error} />;
  const v = f ?? { th: String(Number(s.data.po_approval_threshold)), days: s.data.quotation_valid_days };
  const edit = can("purchasing.settings.manage");
  const save = async () => {
    try { await api.put("/order-settings", { companyId, poApprovalThreshold: v.th || "0", quotationValidDays: Number(v.days) }); toast(tt("حُفظت الإعدادات", "Saved")); setF(null); s.reload(); }
    catch (e) { toast(errMsg(e, lang), true); }
  };
  return <Pane title={tt("عروض الأسعار وأوامر الشراء", "Quotations & purchase orders")}>
    <div className="form-grid">
      <Field label={tt("حد اعتماد أمر الشراء (د.ل)", "PO approval threshold")}><input className="num" disabled={!edit} value={v.th} onChange={(e) => setF({ ...v, th: e.target.value })} /></Field>
      <Field label={tt("صلاحية عرض السعر (أيام)", "Quotation validity (days)")}><input className="num" type="number" min={1} max={365} disabled={!edit} value={v.days} onChange={(e) => setF({ ...v, days: e.target.value })} /></Field>
    </div>
    <p style={{ color: "var(--muted)" }}>{Number(v.th) > 0 ? tt(`أمر الشراء حتى ${v.th} يُعتمد تلقائيًا عند إرساله؛ ما فوقه يعتمده شخص آخر لديه صلاحية الاعتماد.`, `POs up to ${v.th} are auto-approved; above that another user approves.`)
      : tt("كل أمر شراء يحتاج اعتمادًا من شخص آخر غير منشئه.", "Every PO needs approval by someone other than its creator.")}</p>
    {edit && <div className="row"><span className="spacer" /><button className="btn primary" disabled={!f} onClick={save}>{tt("حفظ", "Save")}</button></div>}
  </Pane>;
}

// ------------------------------------------------------------------ POS
function PosPane() {
  const { tt } = useI18n();
  const { companyId } = useSession();
  const regs = useAsync(() => api.get(`/pos/registers?companyId=${companyId}`), [companyId]);
  return <Pane title={tt("نقاط البيع (الكاشيرات)", "POS registers")} desc={tt("كل نقطة بيع = جهاز كاشير مرتبط بمخزن الصالة وحسابات الدرج والخزينة والبطاقات.", "Each register is a till linked to the shop warehouse and drawer/safe/card accounts.")}>
    {regs.loading ? <Loading rows={2} /> : <div className="table-wrap"><table><thead><tr><th>{tt("الرمز", "Code")}</th><th>{tt("الاسم", "Name")}</th><th>{tt("الوردية", "Shift")}</th></tr></thead>
      <tbody>{(regs.data ?? []).map((r: any) => <tr key={r.id}><td className="num">{r.code}</td><td>{r.name_ar}</td><td>{r.open_shift_id ? <span className="badge ok">{tt("مفتوحة", "Open")}</span> : <span className="badge">{tt("مغلقة", "Closed")}</span>}</td></tr>)}</tbody></table></div>}
    <ol className="steps">
      <li>{tt("أضف/عدّل نقطة البيع من «نقاط البيع ← الورديات ← إعداد نقاط البيع».", "Add or edit registers in POS → Shifts → Registers.")}</li>
      <li>{tt("أعطِ الكاشير دور «كاشير» من «المستخدمون».", "Give the cashier the Cashier role in Users.")}</li>
      <li>{tt("الكاشير يفتح «شاشة البيع» ويبدأ وردية بعهدة افتتاح، ويبيع بالباركود أو بالضغط على الصنف، ثم يقفل الوردية بتقرير Z.", "The cashier opens the sales counter, starts a shift, sells by barcode or tap, then closes with a Z report.")}</li>
    </ol>
    <Link to="/pos/shifts" className="btn">{tt("إدارة نقاط البيع والورديات", "Manage registers & shifts")}</Link>
  </Pane>;
}

// ------------------------------------------------------------------ HR & fingerprint
function HrPane() {
  const { tt } = useI18n();
  const { can } = useSession();
  const host = typeof window !== "undefined" ? window.location.host : "";
  const hrSet = can("hr.settings.manage"), hrMan = can("hr.employees.manage");
  return <>
    <RefList title={["أجهزة البصمة", "Fingerprint devices"]} path="/hr/devices" canAdd={hrSet}
      desc={["أجهزة ZKTeco وما يشابهها التي تدعم خاصية Cloud / ADMS: سجّل الرقم التسلسلي هنا، ثم اضبط الجهاز ليرسل إلى خادم النظام.", "ZKTeco-type devices with Cloud/ADMS push: register the serial here, then point the device at this server."]}
      cols={[{ h: ["الاسم", "Name"], v: (r) => r.name }, { h: ["الرقم التسلسلي", "Serial"], v: (r) => <code>{r.serial_number}</code> },
        { h: ["آخر اتصال", "Last seen"], v: (r) => r.last_seen_at ? <span className="badge ok">{fmtDate(r.last_seen_at)}</span> : <span className="badge warn">{tt("لم يتصل بعد", "Not yet")}</span> }]}
      inputs={[{ k: "name", l: ["اسم الجهاز (مثل: بصمة المصنع)", "Device name"] }, { k: "serialNumber", l: ["الرقم التسلسلي (SN)", "Serial number"], ltr: true }]} />
    <Pane title={tt("ضبط جهاز البصمة", "Device set-up")}>
      <ol className="steps">
        <li>{tt("في الجهاز: القائمة ← الاتصال (Comm) ← إعدادات الخادم السحابي (Cloud Server / ADMS).", "On the device: Menu → Comm → Cloud Server / ADMS settings.")}</li>
        <li>{tt("عنوان الخادم:", "Server address:")} <code dir="ltr">{host}</code> · {tt("المنفذ 443 مع تفعيل HTTPS (أو 80 بدونه)", "port 443 with HTTPS (or 80)")}</li>
        <li>{tt("أعد تشغيل الجهاز؛ عند نجاح الاتصال يظهر «آخر اتصال» في الجدول أعلاه وتصل البصمات تلقائيًا.", "Restart the device; “Last seen” appears above and punches arrive automatically.")}</li>
        <li>{tt("اربط كل موظف برقمه في الجهاز (PIN) من ملف الموظف.", "Link each employee to their device PIN in the employee file.")}</li>
      </ol>
    </Pane>
    <HrRules />
    <RefList title={["الأقسام الإدارية", "Departments"]} path="/hr/departments" canAdd={hrMan}
      cols={[{ h: ["الرمز", "Code"], v: (r) => <span className="num">{r.code}</span> }, { h: ["الاسم", "Name"], v: (r) => r.name_ar }]}
      inputs={[{ k: "code", l: ["الرمز", "Code"], ltr: true }, { k: "nameAr", l: ["الاسم", "Name"] },
        { k: "expenseRole", l: ["تُحمّل رواتبه على", "Salary expense"], type: "select", def: "salaries_expense", opts: [["salaries_expense", "مصروف رواتب إدارية", "Admin salaries"], ["direct_labour", "عمالة مباشرة (تكلفة إنتاج)", "Direct labour"], ["commission_expense", "عمولات", "Commissions"], ["field_expense", "مصاريف ميدانية", "Field"]] }]} />
    <RefList title={["الدوامات", "Work schedules"]} path="/hr/schedules" canAdd={hrMan}
      cols={[{ h: ["الاسم", "Name"], v: (r) => r.name_ar }, { h: ["من", "From"], v: (r) => <span className="num">{String(r.start_time).slice(0, 5)}</span> }, { h: ["إلى", "To"], v: (r) => <span className="num">{String(r.end_time).slice(0, 5)}</span> }]}
      inputs={[{ k: "code", l: ["الرمز", "Code"], ltr: true }, { k: "nameAr", l: ["الاسم", "Name"] }, { k: "start", l: ["من", "From"], type: "time", def: "08:00" }, { k: "end", l: ["إلى", "To"], type: "time", def: "16:00" }]} />
    <RefList title={["أنواع الإجازات", "Leave types"]} path="/hr/leave-types" canAdd={hrSet}
      cols={[{ h: ["الاسم", "Name"], v: (r) => r.name_ar }, { h: ["مدفوعة", "Paid"], v: (r) => yes(tt, r.paid) }, { h: ["أيام سنويًا", "Days / year"], v: (r) => r.annual_days ?? "—" }]}
      inputs={[{ k: "code", l: ["الرمز", "Code"], ltr: true }, { k: "nameAr", l: ["الاسم", "Name"] }, { k: "paid", l: ["مدفوعة", "Paid"], type: "check", def: true }, { k: "annualDays", l: ["أيام سنويًا", "Days / year"], type: "number" }]}
      extra={(b) => ({ ...b, annualDays: b.annualDays !== undefined ? String(b.annualDays) : undefined })} />
    <RefList title={["العطلات الرسمية", "Public holidays"]} path="/hr/holidays" canAdd={hrSet}
      cols={[{ h: ["اليوم", "Day"], v: (r) => <span className="num">{fmtDate(r.day)}</span> }, { h: ["المناسبة", "Holiday"], v: (r) => r.name_ar }]}
      inputs={[{ k: "day", l: ["اليوم", "Day"], type: "date" }, { k: "nameAr", l: ["المناسبة", "Holiday"] }]} />
    {can("payroll.runs.prepare") && <RefList title={["بنود الرواتب (بدلات واستقطاعات)", "Pay components"]} path="/payroll/components" canAdd={can("payroll.components.manage")}
      cols={[{ h: ["الاسم", "Name"], v: (r) => r.name_ar }, { h: ["النوع", "Kind"], v: (r) => r.kind === "earning" ? tt("بدل", "Earning") : tt("استقطاع", "Deduction") },
        { h: ["الطريقة", "Method"], v: (r) => r.method === "fixed" ? tt(`مبلغ ثابت ${r.default_value}`, `Fixed ${r.default_value}`) : tt(`${r.default_value}% من الأساسي`, `${r.default_value}% of basic`) }, { h: ["للجميع", "All"], v: (r) => yes(tt, r.applies_to_all) }]}
      inputs={[{ k: "code", l: ["الرمز", "Code"], ltr: true }, { k: "nameAr", l: ["الاسم", "Name"] }, { k: "kind", l: ["النوع", "Kind"], type: "select", def: "earning", opts: [["earning", "بدل", "Earning"], ["deduction", "استقطاع", "Deduction"]] },
        { k: "method", l: ["الطريقة", "Method"], type: "select", def: "fixed", opts: [["fixed", "مبلغ ثابت", "Fixed"], ["percent_of_basic", "نسبة من الأساسي", "% of basic"]] },
        { k: "defaultValue", l: ["القيمة", "Value"] }, { k: "appliesToAll", l: ["لكل الموظفين", "All employees"], type: "check" }]} />}
  </>;
}

function HrRules() {
  const { tt, lang } = useI18n();
  const { companyId, can } = useSession();
  const { toast } = useToast();
  const s = useAsync(() => api.get(`/hr/settings?companyId=${companyId}`), [companyId]);
  const [f, setF] = useState<any>(null);
  if (s.loading) return <Loading rows={2} />;
  if (s.error) return <ErrorBox error={s.error} />;
  const v = f ?? s.data;
  const edit = can("hr.settings.manage");
  const days = [tt("الأحد", "Sun"), tt("الاثنين", "Mon"), tt("الثلاثاء", "Tue"), tt("الأربعاء", "Wed"), tt("الخميس", "Thu"), tt("الجمعة", "Fri"), tt("السبت", "Sat")];
  const set = (k: string, val: unknown) => setF({ ...v, [k]: val });
  const save = async () => {
    try {
      await api.patch("/hr/settings", { companyId, weekendDays: v.weekend_days, lateGraceMin: Number(v.late_grace_min), lateFreePerMonth: Number(v.late_free_per_month), earlyGraceMin: Number(v.early_grace_min),
        overtimeRequiresApproval: v.overtime_requires_approval, overtimeMultiplier: String(v.overtime_multiplier), appPunchEnabled: v.app_punch_enabled });
      toast(tt("حُفظت قواعد الحضور", "Saved")); setF(null); s.reload();
    } catch (e) { toast(errMsg(e, lang), true); }
  };
  return <Pane title={tt("قواعد الحضور والرواتب", "Attendance & payroll rules")}>
    <Field label={tt("أيام العطلة الأسبوعية", "Weekend days")}><div className="seg">{days.map((d, i) => <button key={i} disabled={!edit} className={v.weekend_days?.includes(i) ? "on" : ""}
      onClick={() => set("weekend_days", v.weekend_days.includes(i) ? v.weekend_days.filter((x: number) => x !== i) : [...v.weekend_days, i].sort())}>{d}</button>)}</div></Field>
    <div className="form-grid" style={{ marginTop: 12 }}>
      <Field label={tt("سماح التأخير (دقيقة)", "Late grace (min)")}><input className="num" type="number" disabled={!edit} value={v.late_grace_min} onChange={(e) => set("late_grace_min", e.target.value)} /></Field>
      <Field label={tt("مرات تأخير مسموحة شهريًا", "Free lates / month")}><input className="num" type="number" disabled={!edit} value={v.late_free_per_month} onChange={(e) => set("late_free_per_month", e.target.value)} /></Field>
      <Field label={tt("سماح الخروج المبكر (دقيقة)", "Early-leave grace (min)")}><input className="num" type="number" disabled={!edit} value={v.early_grace_min} onChange={(e) => set("early_grace_min", e.target.value)} /></Field>
      <Field label={tt("معامل العمل الإضافي", "Overtime multiplier")}><input className="num" disabled={!edit} value={v.overtime_multiplier} onChange={(e) => set("overtime_multiplier", e.target.value)} /></Field>
    </div>
    <label className="setting-row"><span><b>{tt("العمل الإضافي يحتاج موافقة", "Overtime needs approval")}</b><small>{tt("لا يُحتسب إلا بعد اعتماده من الموارد البشرية", "Counted only once HR approves it")}</small></span>
      <input type="checkbox" className="toggle" disabled={!edit} checked={!!v.overtime_requires_approval} onChange={(e) => set("overtime_requires_approval", e.target.checked)} /></label>
    <label className="setting-row"><span><b>{tt("البصمة من تطبيق الجوال", "Punch from the mobile app")}</b><small>{tt("للموظفين خارج المصنع (مع الموقع)", "For staff away from the factory (with location)")}</small></span>
      <input type="checkbox" className="toggle" disabled={!edit} checked={!!v.app_punch_enabled} onChange={(e) => set("app_punch_enabled", e.target.checked)} /></label>
    {edit && <div className="row" style={{ marginTop: 12 }}><span className="spacer" /><button className="btn primary" disabled={!f} onClick={save}>{tt("حفظ", "Save")}</button></div>}
  </Pane>;
}

