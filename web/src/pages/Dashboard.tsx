import { Link } from "react-router-dom";
import { FileText, Wallet, ScanBarcode, Factory, PackageCheck, Smartphone, NotebookPen, Users, Microscope, Headset, BarChart3, Stamp,
  AlertCircle, CheckCircle2, Zap, TrendingUp, ClipboardList, Banknote, type LucideIcon } from "lucide-react";
import { api, fmt } from "../api";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { Loading, useAsync } from "../ui";

interface Quick { to: string; icon: LucideIcon; ar: string; en: string; subAr: string; subEn: string; show: boolean }
const safe = <T,>(p: Promise<T>) => p.catch(() => null);

export default function Dashboard() {
  const { tt, pick, lang } = useI18n();
  const { me, can, companyId } = useSession();
  const has = (m: string) => !!me?.modules.includes(m);
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;

  const quick: Quick[] = [
    { to: "/sales/invoices?new=1", icon: FileText, ar: "فاتورة مبيعات", en: "Sales invoice", subAr: "إنشاء فاتورة جديدة", subEn: "Create a new invoice", show: has("sales") && can("sales.invoices.create") },
    { to: "/sales/receipts", icon: Wallet, ar: "سند قبض", en: "Receipt", subAr: "تحصيل من عميل", subEn: "Collect from a customer", show: has("sales") && can("sales.receipts.create") },
    { to: "/pos", icon: ScanBarcode, ar: "شاشة البيع", en: "Sales counter", subAr: "الكاشير", subEn: "Cashier", show: has("pos") && can("pos.shifts.operate") },
    { to: "/field", icon: Smartphone, ar: "يومي", en: "My day", subAr: "تطبيق المندوب", subEn: "Rep app", show: has("distribution") && can("distribution.field.app") },
    { to: "/manufacturing/orders", icon: Factory, ar: "أمر إنتاج", en: "Production order", subAr: "التخطيط والتنفيذ", subEn: "Plan & execute", show: has("manufacturing") && can("manufacturing.orders.view") },
    { to: "/purchasing/receipts", icon: PackageCheck, ar: "استلام بضاعة", en: "Goods receipt", subAr: "من مورد", subEn: "From a supplier", show: has("purchasing") && can("purchasing.receipts.create") },
    { to: "/quality/checks", icon: Microscope, ar: "فحص جودة", en: "Quality check", subAr: "تسجيل نتيجة", subEn: "Record a result", show: has("quality") && can("quality.view") },
    { to: "/journal?new=1", icon: NotebookPen, ar: "قيد يومية", en: "Journal entry", subAr: "قيد محاسبي", subEn: "Accounting entry", show: has("accounting") && can("accounting.journal.create") },
    { to: "/crm/tickets", icon: Headset, ar: "شكوى عميل", en: "Customer ticket", subAr: "خدمة العملاء", subEn: "Customer service", show: has("crm") && can("crm.tickets.manage") },
    { to: "/hr/payroll", icon: Banknote, ar: "الرواتب", en: "Payroll", subAr: "مسير الشهر", subEn: "Monthly run", show: has("payroll") && can("payroll.runs.prepare") },
    { to: "/hr/employees", icon: Users, ar: "الحضور", en: "Attendance", subAr: "الموظفون والبصمات", subEn: "Staff & punches", show: has("hr") && can("hr.employees.view") },
    { to: "/bi", icon: BarChart3, ar: "التقارير", en: "Reports", subAr: "لوحات التحليل", subEn: "Dashboards", show: has("bi") && can("bi.dashboards.view") },
  ].filter((q) => q.show).slice(0, 8);

  const d = useAsync(async () => {
    if (!companyId) return null;
    const [sales, inv, drafts, approvals, tickets, gl] = await Promise.all([
      has("bi") && can("bi.dashboards.view") && can("sales.reports.view") ? safe(api.get(`/bi/dashboards/sales?companyId=${companyId}&from=${monthStart}&to=${today}`)) : null,
      has("bi") && can("bi.dashboards.view") && can("inventory.stock.view") ? safe(api.get(`/bi/dashboards/inventory?companyId=${companyId}&from=${monthStart}&to=${today}`)) : null,
      has("accounting") && can("accounting.journal.post") ? safe(api.get(`/accounting/journal-entries?companyId=${companyId}&status=draft&pageSize=1`)) : null,
      has("documents") ? safe(api.get("/approvals/inbox")) : null,
      has("crm") && can("crm.view") ? safe(api.get(`/crm/tickets?companyId=${companyId}&status=open`)) : null,
      can("core.golive.view") ? safe(api.get(`/go-live/readiness?companyId=${companyId}`)) : null,
    ]);
    return { sales, inv, drafts, approvals, tickets, gl };
  }, [companyId]);

  const k = (dash: any, key: string) => dash?.kpis?.find((x: any) => x.key === key);
  const kpis = d.data ? [
    k(d.data.sales, "net_sales") && { ...k(d.data.sales, "net_sales"), to: "/bi" },
    k(d.data.sales, "invoices") && { ...k(d.data.sales, "invoices"), to: "/sales/invoices" },
    k(d.data.sales, "overdue_ar") && { ...k(d.data.sales, "overdue_ar"), to: "/sales/aging" },
    k(d.data.inv, "stock_value") && { ...k(d.data.inv, "stock_value"), to: "/inventory/stock" },
  ].filter(Boolean) as any[] : [];
  const attention = d.data ? [
    d.data.drafts?.total ? { to: "/journal?status=draft", ar: `${d.data.drafts.total} قيد بانتظار الترحيل`, en: `${d.data.drafts.total} entries awaiting posting`, icon: NotebookPen } : null,
    d.data.approvals?.length ? { to: "/approvals", ar: `${d.data.approvals.length} طلب بانتظار اعتمادك`, en: `${d.data.approvals.length} approvals waiting for you`, icon: Stamp } : null,
    d.data.tickets?.length ? { to: "/crm/tickets", ar: `${d.data.tickets.length} تذكرة مفتوحة`, en: `${d.data.tickets.length} open tickets`, icon: Headset } : null,
    k(d.data.inv, "expired_lots")?.value ? { to: "/quality/trace", ar: `${k(d.data.inv, "expired_lots").value} تشغيلة منتهية في مخازن صالحة`, en: "Expired lots in sellable stores", icon: AlertCircle, bad: true } : null,
    k(d.data.inv, "below_reorder")?.value ? { to: "/insights", ar: `${k(d.data.inv, "below_reorder").value} صنف تحت حد إعادة الطلب`, en: "Items below reorder level", icon: ClipboardList } : null,
    d.data.gl && !d.data.gl.ready ? { to: "/go-live", ar: `جاهزية التشغيل ${d.data.gl.score}% — ${d.data.gl.blocking} بند يحتاج إكمال`, en: `Go-live readiness ${d.data.gl.score}%`, icon: Zap } : null,
  ].filter(Boolean) as any[] : [];

  const hour = new Date().getHours();
  const greet = hour < 12 ? tt("صباح الخير", "Good morning") : tt("مساء الخير", "Good evening");
  const dateText = new Date().toLocaleDateString(lang === "ar" ? "ar-LY" : "en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const fmtK = (x: any) => x.format === "money" ? fmt(x.value) : x.format === "pct" ? `${Number(x.value).toFixed(1)}%` : Number(x.value).toLocaleString("en-US");

  return <>
    <section className="welcome">
      <div><div className="date">{dateText}</div><h1>{greet}، {me!.user.full_name.split(/\s+/).filter((w) => w.toUpperCase() !== "DEMO").slice(0, 2).join(" ") || me!.user.full_name}</h1>
        <p>{pick(me!.tenant.legal_name, me!.tenant.name_en)}</p></div>
      <div className="row" style={{ gap: 10 }}>
        {can("bi.dashboards.view") && has("bi") && <Link to="/bi" className="btn primary"><TrendingUp size={17} />{tt("لوحة الأداء", "Performance")}</Link>}
      </div>
    </section>

    {quick.length > 0 && <>
      <div className="section-title"><Zap size={18} />{tt("إجراءات سريعة", "Quick actions")}</div>
      <div className="quick-grid">{quick.map((q) => <Link key={q.to} to={q.to} className="quick"><span className="q-icon"><q.icon size={21} /></span><b>{pick(q.ar, q.en)}</b><small>{pick(q.subAr, q.subEn)}</small></Link>)}</div>
    </>}

    {d.loading ? <Loading /> : <>
      {kpis.length > 0 && <>
        <div className="section-title"><BarChart3 size={18} />{tt("هذا الشهر", "This month")}</div>
        <div className="grid kpis">{kpis.map((x) => <Link key={x.key} to={x.to} className="card kpi"><div className="label">{pick(x.ar, x.en)}</div><div className="value num">{fmtK(x)}</div></Link>)}</div>
      </>}
      <div className="section-title"><AlertCircle size={18} />{tt("يحتاج انتباهك", "Needs your attention")}</div>
      <div className="card" style={{ padding: 8 }}>
        {attention.length ? attention.map((a) => <Link key={a.to} to={a.to} className="attention-row"><span className={`att-icon ${a.bad ? "bad" : ""}`}><a.icon size={18} /></span><span>{pick(a.ar, a.en)}</span><span className="spacer" /><span className="att-go">{tt("فتح", "Open")}</span></Link>)
          : <div className="attention-row ok"><span className="att-icon ok"><CheckCircle2 size={18} /></span>{tt("لا شيء معلّق — كل شيء على ما يرام", "Nothing pending — all good")}</div>}
      </div>
    </>}
  </>;
}
