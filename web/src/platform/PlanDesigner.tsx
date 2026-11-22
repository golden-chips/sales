// Plan designer for the platform owner: prices, limits and modules, with live checks —
// a module's requirements are added automatically, impossible plans cannot be saved,
// and weak plans / price mistakes / changes that affect live customers are flagged.
import { useMemo, useState } from "react";
import { AlertTriangle, Ban, Info, Lock } from "lucide-react";
import { api } from "../api";
import { useI18n } from "../i18n";
import { ErrorBox, Field, Modal, useAsync, useToast } from "../ui";
import { PlanCards } from "../PlanCards";

const P = "platform" as const;
type Rule = { requires?: string[]; why?: [string, string]; recommends?: { modules: string[]; why: [string, string] }[]; notBuilt?: boolean; always?: boolean };
type Mod = { code: string; name_ar: string; name_en: string; rule: Rule };

const GROUPS: [string, string, string[]][] = [
  ["الأساس", "Foundation", ["core", "accounting"]],
  ["التجارة", "Trading", ["inventory", "sales", "purchasing", "pos", "crm"]],
  ["التوزيع", "Distribution", ["distribution", "fleet"]],
  ["التصنيع", "Manufacturing", ["manufacturing", "quality"]],
  ["الموظفون", "People", ["hr", "payroll"]],
  ["الإدارة والتحليل", "Management & analytics", ["assets", "documents", "projects", "bi", "ai"]],
];

export function PlanDesigner({ plan, onClose, onSaved }: { plan: any | null; onClose: () => void; onSaved: () => void }) {
  const { tt, pick } = useI18n();
  const { toast } = useToast();
  const mods = useAsync<Mod[]>(() => api.get("/platform/modules", P), []);
  const editing = !!plan;
  const [f, setF] = useState(() => ({
    code: plan?.code ?? "", nameAr: plan?.name_ar ?? "", nameEn: plan?.name_en ?? "", currency: plan?.currency ?? "LYD",
    priceMonthly: plan ? String(Number(plan.price_monthly)) : "0", priceYearly: plan ? String(Number(plan.price_yearly)) : "0",
    trialDays: plan?.trial_days ?? 14, graceDays: plan?.grace_days ?? 7, maxUsers: plan?.max_users ?? 5, maxCompanies: plan?.max_companies ?? 1,
    maxBranches: plan?.max_branches ?? 1, maxWarehouses: plan?.max_warehouses ?? 2, storageMb: plan?.storage_mb ?? 2048, apiRpm: plan?.api_rpm ?? 300,
    isPublic: plan?.is_public ?? true, isActive: plan?.is_active ?? true,
  }));
  const [sel, setSel] = useState<Set<string>>(() => new Set(plan?.modules ?? ["core", "accounting"]));
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const byCode = useMemo(() => Object.fromEntries((mods.data ?? []).map((m) => [m.code, m])), [mods.data]);
  const name = (c: string) => (byCode[c] ? pick(byCode[c].name_ar, byCode[c].name_en) : c);

  /** ticking adds everything it needs; unticking removes what depended on it — both are reported */
  const toggle = (code: string) => {
    const m = byCode[code];
    if (!m || m.rule.always) return;
    const next = new Set(sel);
    if (next.has(code)) {
      const removed: string[] = [];
      const drop = (c: string) => { next.delete(c); for (const x of [...next]) if (byCode[x]?.rule.requires?.includes(c)) { removed.push(x); drop(x); } };
      drop(code);
      setNote(removed.length ? tt(`أُزيل أيضًا ${removed.map((x) => `«${name(x)}»`).join(" و")} لأنه يعتمد على «${name(code)}».`, `Also removed ${removed.map(name).join(", ")} (depends on ${name(code)}).`) : null);
    } else {
      const added: string[] = [];
      const add = (c: string) => { if (next.has(c)) return; next.add(c); for (const r of byCode[c]?.rule.requires ?? []) if (!next.has(r)) { added.push(r); add(r); } };
      add(code);
      setNote(added.length ? tt(`أُضيف تلقائيًا ${added.map((x) => `«${name(x)}»`).join(" و")} لأن «${name(code)}» يحتاجه.`, `Added ${added.map(name).join(", ")} automatically (needed by ${name(code)}).`) : null);
    }
    setSel(next);
  };

  // live checks (the server repeats the blocking ones on save)
  const warnings: string[] = [];
  for (const c of sel) {
    const r = byCode[c]?.rule; if (!r) continue;
    for (const rec of r.recommends ?? []) { const lack = rec.modules.filter((x) => !sel.has(x)); if (lack.length) warnings.push(tt(`يُنصح بإضافة ${lack.map((x) => `«${name(x)}»`).join(" و")} مع «${name(c)}»: ${rec.why[0]}`, `Consider ${lack.map(name).join(", ")} with ${name(c)}: ${rec.why[1]}`)); }
    if (r.notBuilt) warnings.push(tt(`«${name(c)}» غير منفّذ بعد — لا تبعه للعملاء كميزة جاهزة.`, `${name(c)} is not built yet — do not sell it as ready.`));
  }
  const pm = Number(f.priceMonthly) || 0, py = Number(f.priceYearly) || 0;
  if (pm > 0 && py === 0) warnings.push(tt("السعر السنوي صفر بينما الشهري له سعر — سيظهر السنوي «حسب الاتفاق».", "Yearly price is 0 while monthly is set."));
  if (pm > 0 && py >= pm * 12) warnings.push(tt(`السعر السنوي (${py}) لا يقل عن 12 شهرًا (${pm * 12}) — لا يوجد خصم يشجّع الدفع السنوي.`, "Yearly price gives no discount over 12 months."));
  if (pm === 0 && py === 0) warnings.push(tt("لا يوجد سعر — ستظهر الباقة للعملاء «السعر حسب الاتفاق».", "No price set — shown as “price on request”."));
  if (Number(f.maxBranches) > Number(f.maxWarehouses) * 3) warnings.push(tt("عدد الفروع كبير مقارنة بالمخازن — غالبًا لكل فرع مخزن واحد على الأقل.", "Many branches for few warehouses."));
  const removedLive = editing ? (plan.modules as string[]).filter((m) => !sel.has(m)) : [];
  const liveImpact = editing && plan.tenants > 0 && (removedLive.length > 0 || Number(f.maxUsers) < plan.max_users || Number(f.maxBranches) < plan.max_branches || Number(f.maxWarehouses) < plan.max_warehouses || !f.isActive);

  const save = async () => {
    setErr(null); setBusy(true);
    const body = { ...f, priceMonthly: pm, priceYearly: py, trialDays: Number(f.trialDays), graceDays: Number(f.graceDays), maxUsers: Number(f.maxUsers), maxCompanies: Number(f.maxCompanies),
      maxBranches: Number(f.maxBranches), maxWarehouses: Number(f.maxWarehouses), storageMb: Number(f.storageMb), apiRpm: Number(f.apiRpm), modules: [...sel] };
    try {
      if (editing) { const { code: _c, ...rest } = body; await api.put(`/platform/plans/${plan.code}`, rest, { scope: P }); }
      else await api.post("/platform/plans", body, { scope: P });
      toast(tt("حُفظت الباقة", "Plan saved")); onSaved();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const num = (k: keyof typeof f, label: string, min = 1) => <Field label={label}><input className="num" type="number" min={min} value={String(f[k])} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>;
  const preview = { code: f.code || "new", name_ar: f.nameAr || tt("باقة جديدة", "New plan"), name_en: f.nameEn || "New plan", currency: f.currency, price_monthly: pm, price_yearly: py,
    max_users: f.maxUsers, max_branches: f.maxBranches, max_warehouses: f.maxWarehouses, modules: [...sel] };

  return <Modal wide title={editing ? `${tt("تعديل الباقة", "Edit plan")} — ${pick(plan.name_ar, plan.name_en)}` : tt("تصميم باقة جديدة", "Design a new plan")} onClose={onClose}
    footer={<><button className="btn" onClick={onClose}>{tt("إلغاء", "Cancel")}</button><button className="btn primary" disabled={busy || !f.nameAr || (!editing && !f.code)} onClick={save}>{tt("حفظ الباقة", "Save plan")}</button></>}>
    <ErrorBox error={err} />
    <div className="designer">
      <div className="grid" style={{ gap: 14 }}>
        <h3 style={{ margin: 0 }}>{tt("الاسم والسعر", "Name & price")}</h3>
        <div className="form-grid">
          <Field label={tt("الرمز (إنجليزي صغير، لا يتغير)", "Code (lowercase, fixed)")}><input dir="ltr" disabled={editing} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "") })} placeholder="factory_plus" /></Field>
          <Field label={tt("الاسم بالعربي", "Arabic name")}><input value={f.nameAr} onChange={(e) => setF({ ...f, nameAr: e.target.value })} /></Field>
          <Field label={tt("الاسم بالإنجليزي", "English name")}><input dir="ltr" value={f.nameEn} onChange={(e) => setF({ ...f, nameEn: e.target.value })} /></Field>
          <Field label={tt("العملة", "Currency")}><input dir="ltr" maxLength={3} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} /></Field>
          {num("priceMonthly", tt("السعر الشهري", "Monthly price"), 0)}
          {num("priceYearly", tt("السعر السنوي", "Yearly price"), 0)}
        </div>
        <h3 style={{ margin: 0 }}>{tt("الحدود", "Limits")}</h3>
        <div className="form-grid">
          {num("maxUsers", tt("المستخدمون", "Users"))}{num("maxCompanies", tt("الشركات", "Companies"))}{num("maxBranches", tt("الفروع", "Branches"))}{num("maxWarehouses", tt("المخازن", "Warehouses"))}
          {num("trialDays", tt("أيام التجربة", "Trial days"), 0)}{num("graceDays", tt("أيام السماح بعد الانتهاء", "Grace days"), 0)}
          {num("storageMb", tt("مساحة الملفات (ميغابايت)", "Storage (MB)"))}{num("apiRpm", tt("طلبات في الدقيقة", "Requests / minute"))}
        </div>
        <div className="row" style={{ gap: 18 }}>
          <label className="row"><input type="checkbox" style={{ width: "auto", minHeight: 0 }} checked={f.isPublic} onChange={(e) => setF({ ...f, isPublic: e.target.checked })} />{tt("تظهر للعملاء", "Shown to customers")}</label>
          <label className="row"><input type="checkbox" style={{ width: "auto", minHeight: 0 }} checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />{tt("فعّالة", "Active")}</label>
        </div>
        <h3 style={{ margin: 0 }}>{tt("الأقسام المشمولة", "Included modules")}</h3>
        {mods.loading ? <div className="muted">…</div> : <div className="mod-groups">{GROUPS.map(([ar, en, codes]) => <div key={en} className="mod-group">
          <b>{pick(ar, en)}</b>
          {codes.filter((c) => byCode[c]).map((c) => { const r = byCode[c].rule; return <label key={c} className={`mod-item ${sel.has(c) ? "on" : ""}`} title={r.why ? pick(r.why[0], r.why[1]) : ""}>
            <input type="checkbox" style={{ width: "auto", minHeight: 0 }} checked={sel.has(c)} disabled={r.always} onChange={() => toggle(c)} />
            <span>{name(c)}</span>
            {r.always && <Lock size={13} aria-label={tt("إلزامي", "required")} />}
            {r.notBuilt && <span className="badge warn">{tt("غير منفّذ", "not built")}</span>}
            {!!r.requires?.length && <small>{tt("يحتاج: ", "needs: ")}{r.requires.map(name).join("، ")}</small>}
          </label>; })}
        </div>)}</div>}
        {note && <div className="alert info"><Info size={16} /> {note}</div>}
      </div>
      <div className="grid" style={{ gap: 12, alignContent: "start" }}>
        <h3 style={{ margin: 0 }}>{tt("كيف يراها العميل", "Customer preview")}</h3>
        <PlanCards plans={[preview]} />
        {liveImpact && <div className="alert bad"><Ban size={16} /> {tt(`${plan.tenants} شركة على هذه الباقة الآن — التغيير يطبّق عليهم فورًا`, `${plan.tenants} customers are on this plan — changes apply to them at once`)}
          {removedLive.length > 0 && <>: {tt("سيفقدون", "they lose")} {removedLive.map((x) => `«${name(x)}»`).join(" و")}</>}{!f.isActive && <>. {tt("الإيقاف يمنع اختيارها لعملاء جدد.", "Deactivating hides it from new customers.")}</>}</div>}
        {warnings.length > 0 && <div className="alert warn"><b><AlertTriangle size={16} /> {tt("تنبيهات", "Warnings")}</b><ul style={{ margin: "6px 0 0", paddingInlineStart: 18 }}>{warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}
        {!warnings.length && !liveImpact && <div className="alert ok">{tt("الباقة متكاملة — لا توجد تنبيهات.", "The plan is consistent — no warnings.")}</div>}
      </div>
    </div>
  </Modal>;
}
