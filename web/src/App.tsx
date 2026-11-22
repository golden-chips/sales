import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useSession } from "./session";
import { Loading } from "./ui";
import { Shell } from "./shell";
export { TopControls } from "./shell";
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
import { PurchaseOrders, Quotations, SalesOrders } from "./pages/erp/Orders";
import { Formulas, Mrp, ProductionOrders } from "./pages/mfg/Manufacturing";
import { NonConformances, QualityChecks, QualitySpecs, TraceRecall } from "./pages/mfg/Quality";
import RepApp from "./pages/field/RepApp";
import { Commissions, Notifications, Performance, Reps, Settlements } from "./pages/field/Distribution";
import Import from "./pages/admin/Import";
import { Employees, Leaves, MyHr, Payroll } from "./pages/hr/Hr";
import { AssetRegister, Depreciation, Maintenance } from "./pages/assets/Assets";
import { PosCounter, PosShifts } from "./pages/pos/Pos";
import { BiDashboards } from "./pages/bi/Bi";
import { Insights } from "./pages/bi/Insights";
import { GoLive, Uat } from "./pages/golive/GoLive";
import { CrmLeads, CrmPipeline, CrmTickets, CrmMyActivities } from "./pages/crm/Crm";
import { Documents, ApprovalsInbox } from "./pages/docs/Docs";
import { ProjectsPage, MyProjectTasks } from "./pages/projects/Projects";

export default function App() {
  const { me, loading } = useSession();
  const loc = useLocation();
  if (loc.pathname.startsWith("/platform")) return <PlatformApp />;
  if (loc.pathname === "/signup" && !me) return <Signup />;
  if (loading) return <div className="content"><Loading /></div>;
  if (!me) return <Login />;
  return <Shell>
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
      <Route path="/sales/quotations" element={<Quotations />} />
      <Route path="/sales/orders" element={<SalesOrders />} />
      <Route path="/purchasing/orders" element={<PurchaseOrders />} />
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
      <Route path="/assets" element={<AssetRegister />} />
      <Route path="/assets/depreciation" element={<Depreciation />} />
      <Route path="/maintenance" element={<Maintenance />} />
      <Route path="/bi" element={<BiDashboards />} />
      <Route path="/go-live" element={<GoLive />} />
      <Route path="/uat" element={<Uat />} />
      <Route path="/insights" element={<Insights />} />
      <Route path="/crm/leads" element={<CrmLeads />} />
      <Route path="/crm/pipeline" element={<CrmPipeline />} />
      <Route path="/crm/tickets" element={<CrmTickets />} />
      <Route path="/crm/activities" element={<CrmMyActivities />} />
      <Route path="/documents" element={<Documents />} />
      <Route path="/approvals" element={<ApprovalsInbox />} />
      <Route path="/projects" element={<ProjectsPage />} />
      <Route path="/projects/my-tasks" element={<MyProjectTasks />} />
      <Route path="/pos" element={<PosCounter />} />
      <Route path="/pos/shifts" element={<PosShifts />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  </Shell>;
}
