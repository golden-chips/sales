import { Link } from "react-router-dom";
import { api, fmt } from "../api";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { ErrorBox, Loading, StatusBadge, useAsync } from "../ui";

const PHASES = [
  ["1", "SaaS foundation, IAM, audit", "الأساس: الاشتراكات والصلاحيات والتدقيق", "done"],
  ["2", "General ledger core", "نواة الأستاذ العام", "done"],
  ["2b", "Customers, suppliers, items, sales, purchasing, inventory", "العملاء والموردون والأصناف والمبيعات والمشتريات والمخزون", "done"],
  ["3", "Manufacturing, quality, traceability", "التصنيع والجودة والتتبع", "done"],
  ["4", "Field sales & distribution (van-sales integration)", "المناديب والتوزيع (دمج نظام المناديب)", "next"],
  ["5", "HRMS & payroll (attendance integration)", "الموارد البشرية والرواتب (دمج نظام الحضور)", "planned"],
  ["6", "CRM, POS, assets, documents, BI, AI", "CRM ونقاط البيع والأصول والمستندات والتقارير والذكاء", "planned"],
];

export default function Dashboard() {
  const { t, lang, pick } = useI18n();
  const { me, can, companyId } = useSession();
  const y = new Date().getFullYear();
  const hasAcc = !!me?.modules.includes("accounting") && can("accounting.journal.view");
  const d = useAsync(async () => {
    const [sub, drafts, accounts, years, tb] = await Promise.all([
      can("core.subscription.view") ? api.get("/subscription") : null,
      hasAcc && companyId ? api.get(`/accounting/journal-entries?companyId=${companyId}&status=draft&pageSize=1`) : null,
      hasAcc && companyId && can("accounting.accounts.view") ? api.get(`/accounting/accounts?companyId=${companyId}`) : null,
      hasAcc && companyId ? api.get(`/accounting/fiscal-years?companyId=${companyId}`) : null,
      hasAcc && companyId && can("accounting.reports.view") ? api.get(`/accounting/reports/trial-balance?companyId=${companyId}&from=${y}-01-01&to=${y}-12-31`) : null,
    ]);
    return { sub, drafts, accounts, years, tb };
  }, [companyId]);
  if (d.loading) return <Loading />;
  if (d.error) return <ErrorBox error={d.error} />;
  const { sub, drafts, accounts, years, tb } = d.data!;
  const today = new Date().toISOString().slice(0, 10);
  const period = years?.flatMap((fy: any) => fy.periods).find((p: any) => p.start_date <= today && p.end_date >= today);
  const daysLeft = sub?.subscription ? Math.max(0, Math.ceil((new Date(sub.subscription.current_period_end).getTime() - Date.now()) / 86400000)) : null;
  return (
    <>
      <div className="page-head"><div><h1>{t.dashboard}</h1><p>{pick(me!.tenant.legal_name, me!.tenant.name_en)} · {me!.tenant.base_currency} · {me!.tenant.timezone}</p></div><span className="kbd">{t.shortcuts}</span></div>
      <div className="grid kpis">
        {sub && <div className="card kpi"><div className="label">{t.plan}</div><div className="value">{pick(sub.subscription?.plan_name_ar, sub.subscription?.plan_name_en)}</div><div className="row"><StatusBadge s={sub.subscription?.status} /><span className="num">{daysLeft}</span> {t.daysLeft}</div></div>}
        {sub && <div className="card kpi"><div className="label">{t.usersCount}</div><div className="value num">{sub.usage.active_users} / {sub.subscription?.max_users}</div></div>}
        {accounts && <Link to="/accounts" className="card kpi"><div className="label">{t.accountsCount}</div><div className="value num">{accounts.length}</div></Link>}
        {drafts && <Link to="/journal?status=draft" className="card kpi"><div className="label">{t.entriesAwaiting}</div><div className="value num">{drafts.total}</div></Link>}
        {period && <Link to="/periods" className="card kpi"><div className="label">{t.currentPeriod}</div><div className="value num">{period.start_date.slice(0, 7)}</div><StatusBadge s={period.status} /></Link>}
        {tb && <Link to="/trial-balance" className="card kpi"><div className="label">{t.trialBalance} {y}</div><div className="value num">{fmt(tb.totals.debit)}</div><span className={`badge ${tb.totals.balanced ? "ok" : "bad"}`}>{tb.totals.balanced ? t.balanced : t.unbalanced}</span></Link>}
      </div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", marginTop: 16 }}>
        <div className="card">
          <h2>{t.modulesInPlan}</h2>
          <div className="row">{me!.modules.map((m) => <span key={m} className="badge info">{m}</span>)}</div>
        </div>
        <div className="card">
          <h2>{t.roadmap}</h2>
          <table><tbody>{PHASES.map(([n, en, ar, s]) => (
            <tr key={n}><td className="num">{n}</td><td style={{ whiteSpace: "normal" }}>{lang === "ar" ? ar : en}</td><td><span className={`badge ${s === "done" ? "ok" : s === "next" ? "warn" : ""}`}>{s}</span></td></tr>
          ))}</tbody></table>
        </div>
      </div>
    </>
  );
}
