// One source of truth for navigation: the sidebar, the quick search (Ctrl+K)
// and the page title all read from here, filtered by plan modules and permissions.
import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard, Smartphone, UserRound, ShoppingCart, FileText, Undo2, Wallet, Users, Hourglass, FileSignature, ClipboardList,
  HandCoins, Truck, Target, Scale, BadgePercent, MessageSquare, PackageCheck, Receipt, Building, Boxes, Package, ArrowLeftRight,
  Factory, FlaskConical, CalendarClock, ShieldCheck, Microscope, AlertTriangle, Route, BookCheck, BarChart3, Sparkles, Contact,
  KanbanSquare, Headset, ListTodo, FolderOpen, Stamp, Briefcase, CheckSquare, ScanBarcode, Clock3, Landmark, TrendingDown, Wrench,
  BookOpen, NotebookPen, Calculator, CalendarRange, Rocket, ClipboardCheck, Upload, UserCog, KeyRound, Building2, ScrollText, CreditCard,
  Settings2, Banknote, CalendarDays, FileSpreadsheet, ClipboardPen, ShoppingBag, SlidersHorizontal, ReceiptText,
} from "lucide-react";

export interface NavItem { to: string; ar: string; en: string; icon: LucideIcon; module?: string; perm?: string | string[]; any?: boolean }
export interface NavGroup { key: string; ar: string; en: string; icon: LucideIcon; items: NavItem[] }

export const HOME: NavItem = { to: "/", ar: "الرئيسية", en: "Home", icon: LayoutDashboard };

export const NAV: NavGroup[] = [
  { key: "me", ar: "مساحتي", en: "My space", icon: UserRound, items: [
    { to: "/field", ar: "يومي (تطبيق المندوب)", en: "My day (rep app)", icon: Smartphone, module: "distribution", perm: "distribution.field.app" },
    { to: "/me", ar: "بوابتي: الحضور والراتب", en: "My attendance & pay", icon: UserRound, module: "hr", perm: "hr.self.view" },
    { to: "/approvals", ar: "اعتماداتي", en: "My approvals", icon: Stamp, module: "documents" },
    { to: "/crm/activities", ar: "متابعاتي", en: "My follow-ups", icon: ListTodo, module: "crm", perm: "crm.view" },
    { to: "/projects/my-tasks", ar: "مهامي", en: "My tasks", icon: CheckSquare, module: "projects", perm: "projects.view" },
  ] },
  { key: "sales", ar: "المبيعات", en: "Sales", icon: ShoppingCart, items: [
    { to: "/sales/quotations", ar: "عروض الأسعار", en: "Quotations", icon: FileSpreadsheet, module: "sales", perm: "sales.quotations.manage" },
    { to: "/sales/orders", ar: "أوامر البيع", en: "Sales orders", icon: ClipboardPen, module: "sales", perm: "sales.orders.manage" },
    { to: "/sales/invoices", ar: "فواتير المبيعات", en: "Sales invoices", icon: FileText, module: "sales", perm: "sales.invoices.view" },
    { to: "/sales/returns", ar: "مرتجعات المبيعات", en: "Sales returns", icon: Undo2, module: "sales", perm: "sales.invoices.view" },
    { to: "/sales/credit-notes", ar: "الإشعارات الدائنة", en: "Credit notes", icon: ReceiptText, module: "sales", perm: "sales.invoices.view" },
    { to: "/sales/receipts", ar: "سندات القبض", en: "Customer receipts", icon: Wallet, module: "sales", perm: "sales.invoices.view" },
    { to: "/customers", ar: "العملاء", en: "Customers", icon: Users, module: "sales", perm: "sales.customers.view" },
    { to: "/sales/aging", ar: "أعمار الديون", en: "AR aging", icon: Hourglass, module: "sales", perm: "sales.reports.view" },
  ] },
  { key: "pos", ar: "نقاط البيع", en: "Point of sale", icon: ScanBarcode, items: [
    { to: "/pos", ar: "شاشة البيع", en: "Sales counter", icon: ScanBarcode, module: "pos", perm: "pos.shifts.operate" },
    { to: "/pos/shifts", ar: "الورديات", en: "Shifts", icon: Clock3, module: "pos", perm: "pos.shifts.operate" },
  ] },
  { key: "distribution", ar: "المناديب والتوزيع", en: "Field sales", icon: Truck, items: [
    { to: "/distribution/reps", ar: "المناديب والمسارات", en: "Reps & routes", icon: Route, module: "distribution", perm: "distribution.reps.view" },
    { to: "/distribution/performance", ar: "الأداء والأهداف", en: "Performance", icon: Target, module: "distribution", perm: "distribution.reps.view" },
    { to: "/distribution/settlements", ar: "التسويات والعهد", en: "Settlements & cash", icon: Scale, module: "distribution", perm: "distribution.reps.view" },
    { to: "/distribution/commissions", ar: "العمولات", en: "Commissions", icon: BadgePercent, module: "distribution", perm: "distribution.reps.view" },
    { to: "/distribution/notifications", ar: "رسائل العملاء", en: "Customer messages", icon: MessageSquare, module: "distribution", perm: "distribution.notifications.view" },
  ] },
  { key: "crm", ar: "علاقات العملاء", en: "CRM", icon: Contact, items: [
    { to: "/crm/leads", ar: "العملاء المحتملون", en: "Leads", icon: Contact, module: "crm", perm: "crm.view" },
    { to: "/crm/pipeline", ar: "الفرص البيعية", en: "Pipeline", icon: KanbanSquare, module: "crm", perm: "crm.view" },
    { to: "/crm/tickets", ar: "الشكاوى والتذاكر", en: "Tickets", icon: Headset, module: "crm", perm: "crm.view" },
  ] },
  { key: "purchasing", ar: "المشتريات", en: "Purchasing", icon: PackageCheck, items: [
    { to: "/purchasing/orders", ar: "أوامر الشراء", en: "Purchase orders", icon: ShoppingBag, module: "purchasing", perm: ["purchasing.orders.manage", "purchasing.orders.approve"], any: true },
    { to: "/purchasing/receipts", ar: "أذونات الاستلام", en: "Goods receipts", icon: PackageCheck, module: "purchasing", perm: "purchasing.receipts.view" },
    { to: "/purchasing/invoices", ar: "فواتير الموردين", en: "Supplier invoices", icon: Receipt, module: "purchasing", perm: "purchasing.receipts.view" },
    { to: "/purchasing/debit-notes", ar: "الإشعارات المدينة", en: "Debit notes", icon: ReceiptText, module: "purchasing", perm: "purchasing.receipts.view" },
    { to: "/suppliers", ar: "الموردون", en: "Suppliers", icon: Building, module: "purchasing", perm: "purchasing.suppliers.view" },
  ] },
  { key: "inventory", ar: "المخازن", en: "Inventory", icon: Boxes, items: [
    { to: "/inventory/stock", ar: "أرصدة المخزون", en: "Stock on hand", icon: Boxes, module: "inventory", perm: "inventory.stock.view" },
    { to: "/inventory/items", ar: "الأصناف", en: "Items", icon: Package, module: "inventory", perm: "inventory.items.view" },
    { to: "/inventory/documents", ar: "المستندات المخزنية", en: "Stock documents", icon: ArrowLeftRight, module: "inventory", perm: "inventory.stock.view" },
  ] },
  { key: "manufacturing", ar: "التصنيع", en: "Manufacturing", icon: Factory, items: [
    { to: "/manufacturing/orders", ar: "أوامر الإنتاج", en: "Production orders", icon: Factory, module: "manufacturing", perm: "manufacturing.orders.view" },
    { to: "/manufacturing/boms", ar: "الوصفات", en: "Formulas", icon: FlaskConical, module: "manufacturing", perm: "manufacturing.boms.view" },
    { to: "/manufacturing/mrp", ar: "تخطيط الاحتياجات", en: "MRP", icon: CalendarClock, module: "manufacturing", perm: "manufacturing.planning.view" },
  ] },
  { key: "quality", ar: "الجودة", en: "Quality", icon: ShieldCheck, items: [
    { to: "/quality/checks", ar: "الفحوصات", en: "Checks", icon: Microscope, module: "quality", perm: "quality.view" },
    { to: "/quality/ncr", ar: "عدم المطابقة", en: "Non-conformance", icon: AlertTriangle, module: "quality", perm: "quality.view" },
    { to: "/quality/trace", ar: "التتبع والاستدعاء", en: "Trace & recall", icon: Route, module: "quality", perm: "quality.view" },
    { to: "/quality/specs", ar: "المواصفات و HACCP", en: "Specs & HACCP", icon: BookCheck, module: "quality", perm: "quality.view" },
  ] },
  { key: "hr", ar: "الموارد البشرية", en: "HR & payroll", icon: Users, items: [
    { to: "/hr/employees", ar: "الموظفون والحضور", en: "Employees & attendance", icon: Users, module: "hr", perm: "hr.employees.view" },
    { to: "/hr/leave", ar: "الإجازات", en: "Leave", icon: CalendarDays, module: "hr", perm: "hr.employees.view" },
    { to: "/hr/payroll", ar: "مسير الرواتب", en: "Payroll", icon: Banknote, module: "payroll", perm: "payroll.runs.prepare" },
  ] },
  { key: "assets", ar: "الأصول والصيانة", en: "Assets & maintenance", icon: Landmark, items: [
    { to: "/assets", ar: "سجل الأصول", en: "Asset register", icon: Landmark, module: "assets", perm: "assets.register.view" },
    { to: "/assets/depreciation", ar: "الإهلاك", en: "Depreciation", icon: TrendingDown, module: "assets", perm: "assets.register.view" },
    { to: "/maintenance", ar: "الصيانة", en: "Maintenance", icon: Wrench, module: "assets", perm: "assets.maintenance.view" },
  ] },
  { key: "finance", ar: "المالية والمحاسبة", en: "Finance", icon: Calculator, items: [
    { to: "/accounts", ar: "دليل الحسابات", en: "Chart of accounts", icon: BookOpen, module: "accounting", perm: "accounting.accounts.view" },
    { to: "/journal", ar: "القيود اليومية", en: "Journal entries", icon: NotebookPen, module: "accounting", perm: "accounting.journal.view" },
    { to: "/trial-balance", ar: "ميزان المراجعة", en: "Trial balance", icon: Calculator, module: "accounting", perm: "accounting.reports.view" },
    { to: "/periods", ar: "السنوات والفترات", en: "Fiscal periods", icon: CalendarRange, module: "accounting", perm: "accounting.journal.view" },
  ] },
  { key: "reports", ar: "التقارير والمستندات", en: "Reports & documents", icon: BarChart3, items: [
    { to: "/bi", ar: "التقارير وذكاء الأعمال", en: "BI & reporting", icon: BarChart3, module: "bi", perm: "bi.dashboards.view" },
    { to: "/insights", ar: "التحليلات الذكية", en: "Smart insights", icon: Sparkles, module: "bi", perm: "bi.insights.view" },
    { to: "/documents", ar: "المستندات", en: "Documents", icon: FolderOpen, module: "documents", perm: "documents.view" },
    { to: "/projects", ar: "المشاريع", en: "Projects", icon: Briefcase, module: "projects", perm: "projects.view" },
  ] },
  { key: "admin", ar: "الإدارة", en: "Administration", icon: Settings2, items: [
    { to: "/settings", ar: "الإعدادات", en: "Settings", icon: SlidersHorizontal },
    { to: "/go-live", ar: "جاهزية التشغيل", en: "Go-live readiness", icon: Rocket, perm: "core.golive.view" },
    { to: "/uat", ar: "اختبارات القبول", en: "Acceptance tests", icon: ClipboardCheck, perm: "core.uat.record" },
    { to: "/import", ar: "استيراد من Excel", en: "Import from Excel", icon: Upload, any: true,
      perm: ["sales.customers.manage", "purchasing.suppliers.manage", "inventory.items.manage", "inventory.moves.create", "accounting.journal.create", "hr.employees.manage"] },
    { to: "/users", ar: "المستخدمون", en: "Users", icon: UserCog, perm: "core.users.view" },
    { to: "/roles", ar: "الأدوار والصلاحيات", en: "Roles & permissions", icon: KeyRound, perm: "core.roles.view" },
    { to: "/organization", ar: "الشركات والفروع والمخازن", en: "Companies & branches", icon: Building2, perm: "core.org.view" },
    { to: "/audit", ar: "سجل التدقيق", en: "Audit log", icon: ScrollText, perm: "core.audit.view" },
    { to: "/subscription", ar: "الاشتراك", en: "Subscription", icon: CreditCard, perm: "core.subscription.view" },
  ] },
];

export function visibleNav(modules: string[], can: (p: string) => boolean): NavGroup[] {
  const ok = (i: NavItem) => (!i.module || modules.includes(i.module)) && (!i.perm || (Array.isArray(i.perm) ? i.perm.some(can) : can(i.perm)));
  return NAV.map((g) => ({ ...g, items: g.items.filter(ok) })).filter((g) => g.items.length);
}

/** the nav item for a path (longest matching prefix), used for the page title / breadcrumb */
export function findItem(groups: NavGroup[], path: string): { group?: NavGroup; item: NavItem } | null {
  if (path === "/") return { item: HOME };
  let best: { group: NavGroup; item: NavItem } | null = null;
  for (const g of groups) for (const i of g.items) if (path === i.to || path.startsWith(i.to + "/")) if (!best || i.to.length > best.item.to.length) best = { group: g, item: i };
  return best;
}
