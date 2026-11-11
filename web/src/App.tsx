import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useI18n } from "./i18n";
import { useSession } from "./session";
import { Loading } from "./ui";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Users from "./pages/Users";
import Roles from "./pages/Roles";
import Organization from "./pages/Organization";
import Accounts from "./pages/Accounts";
import Journal from "./pages/Journal";
import TrialBalance from "./pages/TrialBalance";
import Periods from "./pages/Periods";
import AuditLog from "./pages/AuditLog";
import Subscription from "./pages/Subscription";
import PlatformApp from "./platform/PlatformApp";
import Signup from "./pages/Signup";
import TrialBanner from "./pages/TrialBanner";
import Parties from "./pages/erp/Parties";
import Items from "./pages/erp/Items";
import Stock from "./pages/erp/Stock";
import SalesInvoices, { ArAging, Receipts, SalesReturns } from "./pages/erp/Sales";
import PurchaseReceipts, { StockDocuments, SupplierInvoices } from "./pages/erp/Purchasing";
import { Formulas, Mrp, ProductionOrders } from "./pages/mfg/Manufacturing";
import { NonConformances, QualityChecks, QualitySpecs, TraceRecall } from "./pages/mfg/Quality";
import RepApp from "./pages/field/RepApp";
import { Commissions, Notifications, Performance, Reps, Settlements } from "./pages/field/Distribution";
import Import from "./pages/admin/Import";
import { Employees, Leaves, MyHr, Payroll } from "./pages/hr/Hr";

function ThemeToggle() {
  const { t } = useI18n();
  const [theme, setTheme] = useState<string>(() => { try { return localStorage.getItem("theme") || ""; } catch { return ""; } });
  useEffect(() => {
    if (theme) document.documentElement.setAttribute("data-theme", theme); else document.documentElement.removeAttribute("data-theme");
    try { localStorage.setItem("theme", theme); } catch { /* not persisted */ }
  }, [theme]);
  const dark = theme === "dark" || (!theme && matchMedia("(prefers-color-scheme: dark)").matches);
  return <button className="btn sm" onClick={() => setTheme(dark ? "light" : "dark")} title={t.darkMode}>{dark ? "☀" : "☾"}</button>;
}

export function TopControls() {
  const { t, lang, setLang } = useI18n();
  return <><ThemeToggle /><button className="btn sm" onClick={() => setLang(lang === "ar" ? "en" : "ar")}>{t.language}</button></>;
}

function Shell() {
  const { t, pick, tt } = useI18n();
  const { me, can, signOut, companyId, setCompanyId } = useSession();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const nav = useNavigate();
  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.toLowerCase() === "n" && can("accounting.journal.create")) { e.preventDefault(); nav("/journal?new=1"); }
      if (e.key === "/") { const s = document.querySelector<HTMLInputElement>("input[type=search]"); if (s) { e.preventDefault(); s.focus(); } }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [can, nav]);
  if (!me) return null;
  const hasAcc = me.modules.includes("accounting");
  const L = (to: string, label: string, show = true) => show && <NavLink to={to} end={to === "/"}>{label}</NavLink>;
  return (
    <div className="layout">
      <aside className={`sidebar ${open ? "open" : ""}`}>
        <div className="brand"><div className="logo">G</div><div><b>{t.app}</b><small>{pick(me.tenant.legal_name, me.tenant.name_en)}</small></div></div>
        <nav className="nav">
          {L("/", t.dashboard)}
          {L("/field", tt("يومي (تطبيق المندوب)", "My day (rep app)"), me.modules.includes("distribution") && can("distribution.field.app"))}
          {L("/me", tt("بوابتي (الحضور والراتب)", "My HR portal"), me.modules.includes("hr") && can("hr.self.view"))}
          {me.modules.includes("sales") && <div className="nav-group">{tt("المبيعات", "Sales")}</div>}
          {L("/sales/invoices", tt("فواتير المبيعات", "Sales invoices"), me.modules.includes("sales") && can("sales.invoices.view"))}
          {L("/sales/returns", tt("مرتجعات المبيعات", "Sales returns"), me.modules.includes("sales") && can("sales.invoices.view"))}
          {L("/sales/receipts", tt("سندات القبض", "Customer receipts"), me.modules.includes("sales") && can("sales.invoices.view"))}
          {L("/customers", tt("العملاء", "Customers"), me.modules.includes("sales") && can("sales.customers.view"))}
          {L("/sales/aging", tt("أعمار الديون", "AR aging"), me.modules.includes("sales") && can("sales.reports.view"))}
          {me.modules.includes("hr") && can("hr.employees.view") && <div className="nav-group">{tt("الموارد البشرية", "HR")}</div>}
          {L("/hr/employees", tt("الموظفون والحضور", "Employees & attendance"), me.modules.includes("hr") && can("hr.employees.view"))}
          {L("/hr/leave", tt("الإجازات", "Leave"), me.modules.includes("hr") && can("hr.employees.view"))}
          {L("/hr/payroll", tt("مسير الرواتب", "Payroll"), me.modules.includes("payroll") && can("payroll.runs.prepare"))}
          {me.modules.includes("distribution") && can("distribution.reps.view") && <div className="nav-group">{tt("التوزيع", "Distribution")}</div>}
          {L("/distribution/reps", tt("المناديب والمسارات", "Reps & routes"), me.modules.includes("distribution") && can("distribution.reps.view"))}
          {L("/distribution/performance", tt("الأداء والأهداف", "Performance"), me.modules.includes("distribution") && can("distribution.reps.view"))}
          {L("/distribution/settlements", tt("التسويات والعهد", "Settlements & cash"), me.modules.includes("distribution") && can("distribution.reps.view"))}
          {L("/distribution/commissions", tt("العمولات", "Commissions"), me.modules.includes("distribution") && can("distribution.reps.view"))}
          {L("/distribution/notifications", tt("رسائل العملاء", "Customer messages"), me.modules.includes("distribution") && can("distribution.notifications.view"))}
          {me.modules.includes("purchasing") && <div className="nav-group">{tt("المشتريات", "Purchasing")}</div>}
          {L("/purchasing/receipts", tt("أذونات الاستلام", "Goods receipts"), me.modules.includes("purchasing") && can("purchasing.receipts.view"))}
          {L("/purchasing/invoices", tt("فواتير الموردين", "Supplier invoices"), me.modules.includes("purchasing") && can("purchasing.receipts.view"))}
          {L("/suppliers", tt("الموردون", "Suppliers"), me.modules.includes("purchasing") && can("purchasing.suppliers.view"))}
          {me.modules.includes("inventory") && <div className="nav-group">{tt("المخازن", "Inventory")}</div>}
          {L("/inventory/stock", tt("أرصدة المخزون", "Stock on hand"), me.modules.includes("inventory") && can("inventory.stock.view"))}
          {L("/inventory/items", tt("الأصناف", "Items"), me.modules.includes("inventory") && can("inventory.items.view"))}
          {L("/inventory/documents", tt("المستندات المخزنية", "Stock documents"), me.modules.includes("inventory") && can("inventory.stock.view"))}
          {me.modules.includes("manufacturing") && can("manufacturing.orders.view") && <div className="nav-group">{tt("التصنيع", "Manufacturing")}</div>}
          {L("/manufacturing/orders", tt("أوامر الإنتاج", "Production orders"), me.modules.includes("manufacturing") && can("manufacturing.orders.view"))}
          {L("/manufacturing/boms", tt("الوصفات", "Formulas"), me.modules.includes("manufacturing") && can("manufacturing.boms.view"))}
          {L("/manufacturing/mrp", tt("تخطيط الاحتياجات", "MRP"), me.modules.includes("manufacturing") && can("manufacturing.planning.view"))}
          {me.modules.includes("quality") && can("quality.view") && <div className="nav-group">{tt("الجودة", "Quality")}</div>}
          {L("/quality/checks", tt("الفحوصات", "Checks"), me.modules.includes("quality") && can("quality.view"))}
          {L("/quality/ncr", tt("عدم المطابقة", "Non-conformance"), me.modules.includes("quality") && can("quality.view"))}
          {L("/quality/trace", tt("التتبع والاستدعاء", "Trace & recall"), me.modules.includes("quality") && can("quality.view"))}
          {L("/quality/specs", tt("المواصفات و HACCP", "Specs & HACCP"), me.modules.includes("quality") && can("quality.view"))}
          {hasAcc && can("accounting.journal.view") && <div className="nav-group">{t.groupFinance}</div>}
          {L("/accounts", t.coa, hasAcc && can("accounting.accounts.view"))}
          {L("/journal", t.journal, hasAcc && can("accounting.journal.view"))}
          {L("/trial-balance", t.trialBalance, hasAcc && can("accounting.reports.view"))}
          {L("/periods", t.periods, hasAcc && can("accounting.journal.view"))}
          <div className="nav-group">{t.groupAdmin}</div>
          {L("/import", tt("استيراد من Excel", "Import from Excel"), ["sales.customers.manage", "purchasing.suppliers.manage", "inventory.items.manage", "inventory.moves.create", "accounting.journal.create"].some(can))}
          {L("/users", t.users, can("core.users.view"))}
          {L("/roles", t.roles, can("core.roles.view"))}
          {L("/organization", t.organization, can("core.org.view"))}
          {L("/audit", t.audit, can("core.audit.view"))}
          {L("/subscription", t.subscription, can("core.subscription.view"))}
        </nav>
      </aside>
      <div className="main">
        <div className="topbar">
          <div className="row">
            <button className="btn sm menu-btn" onClick={() => setOpen(!open)} aria-label="menu">☰</button>
            {me.tenant.is_demo && <span className="badge demo">DEMO</span>}
            {me.companies.length > 0 && (
              <select value={companyId ?? ""} onChange={(e) => setCompanyId(e.target.value)} style={{ width: "auto" }} aria-label={t.company}>
                {me.companies.map((c) => <option key={c.id} value={c.id}>{c.code} — {pick(c.name_ar, c.name_en)}</option>)}
              </select>
            )}
          </div>
          <div className="row">
            <span style={{ color: "var(--muted)" }}>{me.user.full_name}</span>
            <TopControls />
            <button className="btn sm" onClick={signOut}>{t.logout}</button>
          </div>
        </div>
        <div className="content">
          <TrialBanner />
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/journal" element={<Journal />} />
            <Route path="/trial-balance" element={<TrialBalance />} />
            <Route path="/periods" element={<Periods />} />
            <Route path="/users" element={<Users />} />
            <Route path="/roles" element={<Roles />} />
            <Route path="/organization" element={<Organization />} />
            <Route path="/audit" element={<AuditLog />} />
            <Route path="/subscription" element={<Subscription />} />
            <Route path="/customers" element={<Parties kind="customer" />} />
            <Route path="/suppliers" element={<Parties kind="supplier" />} />
            <Route path="/inventory/items" element={<Items />} />
            <Route path="/inventory/stock" element={<Stock />} />
            <Route path="/inventory/documents" element={<StockDocuments />} />
            <Route path="/sales/invoices" element={<SalesInvoices />} />
            <Route path="/sales/returns" element={<SalesReturns />} />
            <Route path="/sales/receipts" element={<Receipts />} />
            <Route path="/sales/aging" element={<ArAging />} />
            <Route path="/purchasing/receipts" element={<PurchaseReceipts />} />
            <Route path="/purchasing/invoices" element={<SupplierInvoices />} />
            <Route path="/field" element={<RepApp />} />
            <Route path="/import" element={<Import />} />
            <Route path="/me" element={<MyHr />} />
            <Route path="/hr/employees" element={<Employees />} />
            <Route path="/hr/leave" element={<Leaves />} />
            <Route path="/hr/payroll" element={<Payroll />} />
            <Route path="/distribution/reps" element={<Reps />} />
            <Route path="/distribution/performance" element={<Performance />} />
            <Route path="/distribution/settlements" element={<Settlements />} />
            <Route path="/distribution/commissions" element={<Commissions />} />
            <Route path="/distribution/notifications" element={<Notifications />} />
            <Route path="/manufacturing/orders" element={<ProductionOrders />} />
            <Route path="/manufacturing/boms" element={<Formulas />} />
            <Route path="/manufacturing/mrp" element={<Mrp />} />
            <Route path="/quality/checks" element={<QualityChecks />} />
            <Route path="/quality/ncr" element={<NonConformances />} />
            <Route path="/quality/trace" element={<TraceRecall />} />
            <Route path="/quality/specs" element={<QualitySpecs />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const { me, loading } = useSession();
  const loc = useLocation();
  if (loc.pathname.startsWith("/platform")) return <PlatformApp />;
  if (loc.pathname === "/signup" && !me) return <Signup />;
  if (loading) return <div className="content"><Loading /></div>;
  return me ? <Shell /> : <Login />;
}
