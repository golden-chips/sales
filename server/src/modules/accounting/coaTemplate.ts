// Chart-of-accounts TEMPLATE for a food manufacturer + wholesale/van distributor.
// It is a STARTING POINT for the company accountant to review and approve —
// not an approved accounting policy. `role` tags let other modules find the
// right account (e.g. sales invoices post to role 'sales_revenue') without
// hard-coding account codes. Headers (postable=false) group the leaves.
export interface CoaNode { code: string; ar: string; en: string; type: "asset" | "liability" | "equity" | "revenue" | "expense"; postable?: boolean; role?: string; children?: CoaNode[] }

const A = "asset", L = "liability", Q = "equity", R = "revenue", X = "expense";

export const FOOD_MANUFACTURING_COA: CoaNode[] = [
  { code: "1", ar: "الأصول", en: "Assets", type: A, children: [
    { code: "11", ar: "الأصول المتداولة", en: "Current Assets", type: A, children: [
      { code: "111", ar: "النقدية والخزائن", en: "Cash & Cash Boxes", type: A, children: [
        { code: "1111", ar: "الخزينة الرئيسية", en: "Main Cash Box", type: A, postable: true, role: "cash_main" },
        { code: "1112", ar: "عهد نقدية للمناديب", en: "Sales Reps Cash Custody", type: A, postable: true, role: "rep_cash_custody" },
        { code: "1113", ar: "صناديق نقاط البيع", en: "POS Cash Drawers", type: A, postable: true, role: "pos_cash" },
      ] },
      { code: "112", ar: "المصارف", en: "Banks", type: A, children: [
        { code: "1121", ar: "حساب مصرفي رئيسي", en: "Main Bank Account", type: A, postable: true, role: "bank_main" },
        { code: "1129", ar: "حوالات قيد التحصيل", en: "Transfers in Transit", type: A, postable: true, role: "transfers_in_transit" },
      ] },
      { code: "113", ar: "الذمم المدينة", en: "Receivables", type: A, children: [
        { code: "1131", ar: "ذمم العملاء", en: "Trade Receivables", type: A, postable: true, role: "ar" },
        { code: "1132", ar: "سلف وقروض الموظفين", en: "Employee Advances & Loans", type: A, postable: true, role: "employee_advances" },
        { code: "1133", ar: "مدينون متنوعون", en: "Other Receivables", type: A, postable: true },
        { code: "1134", ar: "دفعات مقدمة للموردين", en: "Supplier Prepayments", type: A, postable: true, role: "supplier_prepayments" },
      ] },
      { code: "114", ar: "المخزون", en: "Inventory", type: A, children: [
        { code: "1141", ar: "مخزون المواد الخام", en: "Raw Materials", type: A, postable: true, role: "inventory_raw" },
        { code: "1142", ar: "مخزون مواد التعبئة والتغليف", en: "Packaging Materials", type: A, postable: true, role: "inventory_packaging" },
        { code: "1143", ar: "إنتاج تحت التشغيل", en: "Work in Progress", type: A, postable: true, role: "inventory_wip" },
        { code: "1144", ar: "مخزون المنتجات التامة", en: "Finished Goods", type: A, postable: true, role: "inventory_fg" },
        { code: "1145", ar: "بضاعة بسيارات التوزيع", en: "Goods in Distribution Vans", type: A, postable: true, role: "inventory_van" },
        { code: "1146", ar: "بضاعة بالحجر/تحت الفحص", en: "Quarantine / Under Inspection", type: A, postable: true, role: "inventory_quarantine" },
        { code: "1147", ar: "بضاعة بالطريق (اعتمادات)", en: "Goods in Transit (Imports)", type: A, postable: true, role: "inventory_transit" },
      ] },
    ] },
    { code: "12", ar: "الأصول غير المتداولة", en: "Non-current Assets", type: A, children: [
      { code: "121", ar: "الأصول الثابتة", en: "Property, Plant & Equipment", type: A, children: [
        { code: "1211", ar: "مباني ومنشآت", en: "Buildings", type: A, postable: true },
        { code: "1212", ar: "آلات وخطوط إنتاج", en: "Machinery & Production Lines", type: A, postable: true },
        { code: "1213", ar: "سيارات ووسائل نقل", en: "Vehicles", type: A, postable: true },
        { code: "1214", ar: "أثاث وأجهزة مكتبية", en: "Furniture & IT Equipment", type: A, postable: true },
      ] },
      { code: "122", ar: "مجمع الإهلاك", en: "Accumulated Depreciation", type: A, children: [
        { code: "1221", ar: "مجمع إهلاك المباني", en: "Acc. Dep. Buildings", type: A, postable: true },
        { code: "1222", ar: "مجمع إهلاك الآلات", en: "Acc. Dep. Machinery", type: A, postable: true },
        { code: "1223", ar: "مجمع إهلاك السيارات", en: "Acc. Dep. Vehicles", type: A, postable: true },
        { code: "1224", ar: "مجمع إهلاك الأثاث والأجهزة", en: "Acc. Dep. Furniture & IT", type: A, postable: true },
      ] },
    ] },
  ] },
  { code: "2", ar: "الالتزامات", en: "Liabilities", type: L, children: [
    { code: "21", ar: "الالتزامات المتداولة", en: "Current Liabilities", type: L, children: [
      { code: "2101", ar: "ذمم الموردين", en: "Trade Payables", type: L, postable: true, role: "ap" },
      { code: "2102", ar: "بضاعة مستلمة لم تصل فواتيرها", en: "Goods Received Not Invoiced", type: L, postable: true, role: "grni" },
      { code: "2103", ar: "رواتب وأجور مستحقة", en: "Salaries Payable", type: L, postable: true, role: "salaries_payable" },
      { code: "2104", ar: "استقطاعات موظفين مستحقة", en: "Payroll Deductions Payable", type: L, postable: true, role: "payroll_deductions_payable" },
      { code: "2105", ar: "ضرائب ورسوم مستحقة", en: "Taxes & Duties Payable", type: L, postable: true, role: "tax_payable" },
      { code: "2106", ar: "دفعات مقدمة من العملاء", en: "Customer Advances", type: L, postable: true, role: "customer_advances" },
      { code: "2107", ar: "عمولات مناديب مستحقة", en: "Sales Commissions Payable", type: L, postable: true, role: "commissions_payable" },
      { code: "2108", ar: "مصروفات مستحقة", en: "Accrued Expenses", type: L, postable: true },
    ] },
    { code: "22", ar: "الالتزامات طويلة الأجل", en: "Long-term Liabilities", type: L, children: [
      { code: "2201", ar: "قروض طويلة الأجل", en: "Long-term Loans", type: L, postable: true },
      { code: "2202", ar: "مخصص مكافأة نهاية الخدمة", en: "End-of-Service Provision", type: L, postable: true, role: "eos_provision" },
    ] },
  ] },
  { code: "3", ar: "حقوق الملكية", en: "Equity", type: Q, children: [
    { code: "301", ar: "رأس المال", en: "Share Capital", type: Q, postable: true, role: "capital" },
    { code: "302", ar: "جاري الشركاء", en: "Partners' Current Accounts", type: Q, postable: true },
    { code: "303", ar: "الأرباح المرحلة", en: "Retained Earnings", type: Q, postable: true, role: "retained_earnings" },
    { code: "304", ar: "أرصدة افتتاحية", en: "Opening Balance Equity", type: Q, postable: true, role: "opening_balance" },
  ] },
  { code: "4", ar: "الإيرادات", en: "Revenue", type: R, children: [
    { code: "401", ar: "إيرادات المبيعات", en: "Sales Revenue", type: R, postable: true, role: "sales_revenue" },
    { code: "402", ar: "مردودات المبيعات", en: "Sales Returns", type: R, postable: true, role: "sales_returns" },
    { code: "403", ar: "خصم مسموح به", en: "Sales Discounts", type: R, postable: true, role: "sales_discounts" },
    { code: "404", ar: "إيرادات أخرى", en: "Other Income", type: R, postable: true },
    { code: "405", ar: "أرباح فروق العملة", en: "FX Gains", type: R, postable: true, role: "fx_gain" },
  ] },
  { code: "5", ar: "التكاليف والمصروفات", en: "Costs & Expenses", type: X, children: [
    { code: "51", ar: "تكلفة المبيعات", en: "Cost of Sales", type: X, children: [
      { code: "5101", ar: "تكلفة البضاعة المباعة", en: "Cost of Goods Sold", type: X, postable: true, role: "cogs" },
      { code: "5102", ar: "فروقات تكلفة الإنتاج (فعلي/معياري)", en: "Production Cost Variances", type: X, postable: true, role: "production_variance" },
      { code: "5103", ar: "هالك وتالف الإنتاج", en: "Production Scrap & Waste", type: X, postable: true, role: "production_scrap" },
      { code: "5104", ar: "عجز وزيادة الجرد", en: "Inventory Count Differences", type: X, postable: true, role: "inventory_adjustment" },
    ] },
    { code: "52", ar: "تكاليف صناعية غير مباشرة", en: "Manufacturing Overheads", type: X, children: [
      { code: "5201", ar: "أجور العمالة المباشرة", en: "Direct Labour", type: X, postable: true, role: "direct_labour" },
      { code: "5202", ar: "كهرباء وطاقة المصنع", en: "Factory Power & Energy", type: X, postable: true, role: "factory_energy" },
      { code: "5203", ar: "صيانة الآلات", en: "Machine Maintenance", type: X, postable: true },
      { code: "5204", ar: "إهلاك الآلات", en: "Machinery Depreciation", type: X, postable: true },
      { code: "5205", ar: "تكاليف صناعية محملة", en: "Overheads Absorbed", type: X, postable: true, role: "overhead_absorbed" },
    ] },
    { code: "53", ar: "مصروفات البيع والتوزيع", en: "Selling & Distribution", type: X, children: [
      { code: "5301", ar: "عمولات المناديب", en: "Sales Commissions", type: X, postable: true, role: "commission_expense" },
      { code: "5302", ar: "وقود سيارات التوزيع", en: "Van Fuel", type: X, postable: true, role: "fuel_expense" },
      { code: "5303", ar: "صيانة سيارات التوزيع", en: "Van Maintenance", type: X, postable: true },
      { code: "5304", ar: "مصروفات ميدانية للمناديب", en: "Field Expenses", type: X, postable: true, role: "field_expense" },
      { code: "5305", ar: "دعاية وعروض ترويجية", en: "Marketing & Promotions", type: X, postable: true },
    ] },
    { code: "54", ar: "المصروفات الإدارية والعمومية", en: "General & Administrative", type: X, children: [
      { code: "5401", ar: "رواتب وأجور إدارية", en: "Administrative Salaries", type: X, postable: true, role: "salaries_expense" },
      { code: "5402", ar: "إيجارات", en: "Rent", type: X, postable: true },
      { code: "5403", ar: "اتصالات وإنترنت", en: "Telecom & Internet", type: X, postable: true },
      { code: "5404", ar: "رسوم حكومية", en: "Government Fees", type: X, postable: true },
      { code: "5405", ar: "إهلاك أصول إدارية", en: "Admin Depreciation", type: X, postable: true },
      { code: "5406", ar: "خسائر فروق العملة", en: "FX Losses", type: X, postable: true, role: "fx_loss" },
      { code: "5407", ar: "رسوم مصرفية", en: "Bank Charges", type: X, postable: true },
    ] },
  ] },
];

export const NORMAL_BALANCE: Record<CoaNode["type"], "debit" | "credit"> = { asset: "debit", expense: "debit", liability: "credit", equity: "credit", revenue: "credit" };

/** contra accounts whose normal balance differs from their type */
export const CONTRA_NORMAL: Record<string, "debit" | "credit"> = {
  "402": "debit", "403": "debit", "122": "credit", "1221": "credit", "1222": "credit", "1223": "credit", "1224": "credit",
};
