// What each module needs to work, taken from how the code actually depends on it.
// Used by the plan designer (platform) to block impossible plans and to warn about
// weak ones. "requires" blocks saving; "recommends" only warns.
export interface ModuleRule {
  requires?: string[];
  why?: [string, string];                                   // why the requirement exists (ar, en)
  recommends?: { modules: string[]; why: [string, string] }[];
  notBuilt?: boolean;                                       // listed in the catalogue but no screens/API yet
  always?: boolean;                                         // part of every plan
}

export const MODULE_RULES: Record<string, ModuleRule> = {
  core: { always: true, why: ["المستخدمون والصلاحيات والفروع — أساس كل باقة", "Users, roles and branches — part of every plan"] },
  accounting: { always: true, why: ["كل العمليات (البيع، الشراء، المخزون، الرواتب…) تُرحِّل قيودها للأستاذ العام", "Every operation posts to the general ledger"] },
  inventory: { requires: ["accounting"] },
  sales: { requires: ["inventory"], why: ["فاتورة البيع تُخرج البضاعة من مخزن", "A sales invoice issues goods from a warehouse"] },
  purchasing: { requires: ["inventory"], why: ["إذن الاستلام يُدخل البضاعة لمخزن", "A goods receipt puts goods into a warehouse"] },
  pos: { requires: ["sales", "inventory"], why: ["بيع الصالة فاتورة مبيعات من مخزن الصالة", "A POS sale is a sales invoice from the shop warehouse"] },
  distribution: { requires: ["sales", "inventory"], why: ["المندوب يبيع ويحصّل من مخزن سيارته", "Reps sell and collect from their van warehouse"],
    recommends: [{ modules: ["crm"], why: ["متابعة العملاء والشكاوى تفيد فريق المناديب", "Customer follow-ups help the field team"] }] },
  crm: { requires: ["sales"], why: ["العميل المحتمل يتحول إلى عميل مبيعات", "A lead converts into a sales customer"] },
  manufacturing: { requires: ["inventory"], why: ["الإنتاج يصرف خامات ويُدخل منتجًا تامًا للمخازن", "Production issues materials and receives finished goods"],
    recommends: [{ modules: ["purchasing"], why: ["المصنع يشتري خاماته — بدون المشتريات لا توجد أوامر شراء ولا استلام", "A factory buys its raw materials"] },
      { modules: ["quality"], why: ["لمصانع الأغذية: فحص التشغيلات والتتبع والاستدعاء", "Food factories need lot checks, tracing and recalls"] }] },
  quality: { requires: ["inventory"], why: ["الفحوصات والتتبع تعمل على تشغيلات المخزون", "Checks and tracing work on stock lots"],
    recommends: [{ modules: ["manufacturing"], why: ["فحص الإنتاج والوصفات يحتاج التصنيع", "Production checks need manufacturing"] }] },
  hr: { recommends: [{ modules: ["payroll"], why: ["الحضور يُستعمل غالبًا لاحتساب الرواتب", "Attendance usually feeds payroll"] }] },
  payroll: { requires: ["hr"], why: ["الراتب يُحتسب من ملف الموظف وحضوره", "Pay is computed from the employee file and attendance"] },
  assets: { recommends: [{ modules: ["inventory"], why: ["قطع الغيار لأوامر الصيانة تُصرف من المخازن", "Maintenance spare parts are issued from stock"] }] },
  documents: {},
  projects: {},
  bi: {},
  fleet: { notBuilt: true },
  ai: { notBuilt: true, why: ["التحليلات الذكية الحالية ضمن «التقارير وذكاء الأعمال»", "Current smart insights are part of BI"] },
};

export interface PlanCheck { errors: { module: string; missing: string[]; ar: string; en: string }[]; warnings: { module: string; ar: string; en: string }[] }

/** errors block the plan; warnings are advice. `names` maps module codes to [ar, en] for messages. */
export function checkPlanModules(selected: string[], names: Record<string, [string, string]>): PlanCheck {
  const set = new Set(selected);
  const n = (m: string, i: 0 | 1) => names[m]?.[i] ?? m;
  const out: PlanCheck = { errors: [], warnings: [] };
  for (const m of set) {
    const r = MODULE_RULES[m] ?? {};
    const missing = (r.requires ?? []).filter((x) => !set.has(x));
    if (missing.length) out.errors.push({ module: m, missing,
      ar: `«${n(m, 0)}» يحتاج ${missing.map((x) => `«${n(x, 0)}»`).join(" و")}${r.why ? ` — ${r.why[0]}` : ""}`,
      en: `${n(m, 1)} needs ${missing.map((x) => n(x, 1)).join(" and ")}${r.why ? ` — ${r.why[1]}` : ""}` });
    for (const rec of r.recommends ?? []) {
      const lack = rec.modules.filter((x) => !set.has(x));
      if (lack.length) out.warnings.push({ module: m, ar: `يُنصح بإضافة ${lack.map((x) => `«${n(x, 0)}»`).join(" و")} مع «${n(m, 0)}»: ${rec.why[0]}`,
        en: `Consider adding ${lack.map((x) => n(x, 1)).join(" and ")} with ${n(m, 1)}: ${rec.why[1]}` });
    }
    if (r.notBuilt) out.warnings.push({ module: m, ar: `«${n(m, 0)}» غير منفّذ بعد في النظام — لا تبعه للعملاء كميزة جاهزة${r.why ? ` (${r.why[0]})` : ""}`,
      en: `${n(m, 1)} is not built yet — do not sell it as a ready feature` });
  }
  for (const [m, r] of Object.entries(MODULE_RULES)) if (r.always && !set.has(m))
    out.errors.push({ module: m, missing: [m], ar: `«${n(m, 0)}» إلزامي في كل باقة — ${r.why?.[0] ?? ""}`, en: `${n(m, 1)} is required in every plan — ${r.why?.[1] ?? ""}` });
  return out;
}
