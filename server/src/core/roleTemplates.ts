// System role templates seeded into every tenant. Patterns: exact code,
// "module.*" (whole module) or "*.view" (all view permissions). Templates are
// re-synced idempotently when new permissions ship (syncSystemRoles), so
// tenants get new module permissions without manual work. Tenants may create
// custom roles; system roles cannot be deleted.
export interface RoleTemplate { code: string; nameAr: string; nameEn: string; grants: string[] }

export const ROLE_TEMPLATES: RoleTemplate[] = [
  { code: "tenant_owner", nameAr: "مالك الحساب", nameEn: "Tenant Owner", grants: ["*"] },
  { code: "company_admin", nameAr: "مدير النظام للشركة", nameEn: "Company Admin", grants: ["core.*", "*.view"] },
  { code: "branch_manager", nameAr: "مدير فرع", nameEn: "Branch Manager", grants: ["*.view", "core.users.view"] },
  { code: "finance_manager", nameAr: "المدير المالي", nameEn: "Finance Manager", grants: ["accounting.*", "purchasing.*", "sales.receipts.*", "sales.reports.view", "sales.invoices.view", "sales.customers.view", "inventory.stock.view", "inventory.items.view", "core.org.view", "core.audit.view"] },
  { code: "accountant", nameAr: "محاسب", nameEn: "Accountant",
    grants: ["accounting.accounts.view", "accounting.journal.view", "accounting.journal.create", "accounting.journal.post", "accounting.reports.view", "accounting.fx.manage", "core.org.view",
      "sales.invoices.view", "sales.customers.view", "sales.receipts.create", "sales.reports.view", "purchasing.receipts.view", "purchasing.suppliers.view",
      "purchasing.invoices.create", "purchasing.payments.create", "inventory.stock.view", "inventory.items.view"] },
  { code: "sales_manager", nameAr: "مدير المبيعات", nameEn: "Sales Manager", grants: ["sales.*", "distribution.*", "crm.*", "inventory.items.view", "inventory.stock.view", "core.org.view"] },
  { code: "sales_rep", nameAr: "مندوب مبيعات", nameEn: "Sales Representative", grants: ["distribution.field.*", "sales.customers.view", "sales.invoices.view", "sales.invoices.create", "sales.receipts.create", "inventory.items.view"] },
  { code: "warehouse_manager", nameAr: "مدير المخازن", nameEn: "Warehouse Manager", grants: ["inventory.items.*", "inventory.stock.*", "inventory.moves.*", "purchasing.receipts.*", "purchasing.suppliers.view", "core.org.view"] },
  // quarantine release is deliberately NOT a warehouse permission: releasing goods after inspection belongs to Quality (food safety SoD),
  { code: "warehouse_worker", nameAr: "أمين/عامل مخزن", nameEn: "Warehouse Worker", grants: ["inventory.moves.create", "inventory.stock.view", "inventory.items.view", "purchasing.receipts.create", "purchasing.receipts.view", "purchasing.suppliers.view"] },
  { code: "production_manager", nameAr: "مدير الإنتاج", nameEn: "Production Manager", grants: ["manufacturing.*", "inventory.stock.view", "quality.view"] },
  { code: "production_operator", nameAr: "مشغل إنتاج", nameEn: "Production Operator", grants: ["manufacturing.execution.*"] },
  { code: "hr_manager", nameAr: "مدير الموارد البشرية", nameEn: "HR Manager", grants: ["hr.*", "payroll.*", "core.org.view"] },
  { code: "employee", nameAr: "موظف", nameEn: "Employee", grants: ["hr.self.*"] },
  { code: "quality_manager", nameAr: "مدير الجودة", nameEn: "Quality Manager", grants: ["quality.*", "inventory.stock.view", "inventory.items.view", "inventory.quarantine.release", "inventory.moves.post"] },
  { code: "auditor", nameAr: "مدقق", nameEn: "Auditor", grants: ["*.view", "core.audit.view", "accounting.reports.view"] },
  { code: "read_only", nameAr: "مستخدم اطلاع فقط", nameEn: "Read Only User", grants: ["*.view"] },
];

export function matches(pattern: string, code: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) return code.endsWith(pattern.slice(1));
  if (pattern.endsWith(".*")) return code.startsWith(pattern.slice(0, -1));
  return pattern === code;
}

/**
 * The cross-module "*.view" wildcard never grants SENSITIVE permissions (e.g.
 * audit log); those must be granted explicitly or via "*" / "module.*".
 */
export function expand(grants: string[], all: { code: string; sensitive: boolean }[]): string[] {
  return all
    .filter((p) => grants.some((g) => matches(g, p.code) && !(g.startsWith("*.") && p.sensitive)))
    .map((p) => p.code);
}
