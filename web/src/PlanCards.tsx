// Plan comparison cards: limits, included modules and price, from GET /public/plans.
import { Check, Minus } from "lucide-react";
import { fmt } from "./api";
import { useI18n } from "./i18n";

export const MODULE_NAMES: Record<string, [string, string]> = {
  accounting: ["المحاسبة والأستاذ العام", "Accounting"], sales: ["المبيعات والعملاء", "Sales"], purchasing: ["المشتريات والموردون", "Purchasing"],
  inventory: ["المخازن والتشغيلات", "Inventory"], crm: ["علاقات العملاء", "CRM"], pos: ["نقاط البيع (الصالة)", "Point of sale"], bi: ["التقارير ولوحات التحليل", "BI & reports"],
  distribution: ["المناديب والتوزيع", "Field sales"], fleet: ["الأسطول", "Fleet"], hr: ["الموارد البشرية والحضور", "HR & attendance"], payroll: ["الرواتب", "Payroll"],
  documents: ["المستندات والاعتمادات", "Documents & approvals"], projects: ["المشاريع", "Projects"], manufacturing: ["التصنيع والوصفات", "Manufacturing"],
  quality: ["الجودة والتتبع", "Quality & traceability"], assets: ["الأصول والصيانة", "Assets & maintenance"], ai: ["التحليلات الذكية المتقدمة", "Advanced AI analytics"],
};
const ORDER = Object.keys(MODULE_NAMES);

export function PlanCards({ plans, selected, current, onSelect, cycle = "monthly" }: {
  plans: any[]; selected?: string; current?: string; onSelect?: (code: string) => void; cycle?: "monthly" | "yearly";
}) {
  const { tt, pick } = useI18n();
  const price = (p: any) => {
    const v = Number(cycle === "yearly" ? p.price_yearly : p.price_monthly);
    return v > 0 ? <><b className="num">{fmt(String(v))}</b> <small>{p.currency} / {cycle === "yearly" ? tt("سنة", "year") : tt("شهر", "month")}</small></> : <b>{tt("السعر حسب الاتفاق", "Price on request")}</b>;
  };
  return <div className="plan-grid">
    {plans.map((p) => {
      const mods = new Set<string>(p.modules);
      const isSel = selected === p.code;
      return <button type="button" key={p.code} className={`plan-card ${isSel ? "sel" : ""}`} onClick={() => onSelect?.(p.code)} disabled={!onSelect} aria-pressed={isSel}>
        <div className="plan-head">
          <b className="plan-name">{pick(p.name_ar, p.name_en)}</b>
          {current === p.code && <span className="badge info">{tt("باقتك الحالية", "Current")}</span>}
        </div>
        <div className="plan-price">{price(p)}</div>
        <ul className="plan-limits">
          <li><span>{tt("المستخدمون", "Users")}</span><b className="num">{p.max_users}</b></li>
          <li><span>{tt("الفروع", "Branches")}</span><b className="num">{p.max_branches}</b></li>
          <li><span>{tt("المخازن", "Warehouses")}</span><b className="num">{p.max_warehouses}</b></li>
        </ul>
        <ul className="plan-mods">
          {ORDER.map((m) => <li key={m} className={mods.has(m) ? "" : "off"}>
            {mods.has(m) ? <Check size={15} /> : <Minus size={15} />}<span>{pick(...MODULE_NAMES[m])}</span></li>)}
        </ul>
        {onSelect && <span className={`btn ${isSel ? "primary" : ""} plan-pick`}>{isSel ? tt("✓ اخترتها", "✓ Selected") : tt("اختر هذه الباقة", "Choose")}</span>}
      </button>;
    })}
  </div>;
}
