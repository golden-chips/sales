import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const ar = {
  app: "GOLDEN ERP", tagline: "منصة تخطيط موارد المؤسسات", login: "تسجيل الدخول", logout: "خروج", tenant: "رمز الشركة", email: "البريد الإلكتروني",
  password: "كلمة المرور", otp: "رمز التحقق (6 أرقام)", signingIn: "جارٍ الدخول…", dashboard: "لوحة التحكم", users: "المستخدمون", roles: "الأدوار والصلاحيات",
  organization: "الشركات والفروع والمخازن", coa: "دليل الحسابات", journal: "القيود اليومية", trialBalance: "ميزان المراجعة", periods: "السنوات والفترات المالية",
  audit: "سجل التدقيق", subscription: "الاشتراك", settings: "الإعدادات", groupAdmin: "الإدارة", groupFinance: "المالية والمحاسبة",
  save: "حفظ", cancel: "إلغاء", create: "إنشاء", add: "إضافة", search: "بحث…", loading: "جارٍ التحميل…", none: "لا توجد بيانات بعد", confirm: "تأكيد",
  active: "نشط", inactive: "موقوف", status: "الحالة", name: "الاسم", code: "الرمز", type: "النوع", actions: "إجراءات", date: "التاريخ", memo: "البيان",
  debit: "مدين", credit: "دائن", balance: "الرصيد", total: "الإجمالي", account: "الحساب", number: "الرقم", draft: "مسودة", posted: "مرحّل", reversed: "معكوس",
  post: "ترحيل", reverse: "عكس القيد", delete: "حذف", newEntry: "قيد جديد", addLine: "إضافة سطر", difference: "الفرق", balanced: "متوازن", unbalanced: "غير متوازن",
  opening: "رصيد افتتاحي", movement: "حركة الفترة", closing: "رصيد ختامي", from: "من", to: "إلى", show: "عرض", ledger: "دفتر الأستاذ", company: "الشركة",
  branch: "الفرع", warehouse: "المخزن", branches: "الفروع", warehouses: "المخازن", companies: "الشركات", kind: "النوع", sellable: "قابل للبيع",
  fullName: "الاسم الكامل", role: "الدور", lastLogin: "آخر دخول", permissions: "الصلاحيات", seedCoa: "إنشاء دليل حسابات مقترح (للمراجعة)",
  coaEmpty: "لا يوجد دليل حسابات لهذه الشركة بعد.", coaTemplateNote: "الدليل المقترح نقطة بداية يجب أن يراجعها ويعتمدها محاسب الشركة.",
  closePeriod: "إقفال", reopenPeriod: "إعادة فتح", open: "مفتوحة", closed: "مقفلة", reason: "السبب", plan: "الباقة", usage: "الاستخدام", limit: "الحد",
  invoices: "الفواتير", amount: "المبلغ", demo: "تجريبي", platform: "إدارة المنصة", tenants: "الشركات المشتركة", plans: "الباقات", suspend: "تعليق",
  reactivate: "إعادة تفعيل", changePlan: "تغيير الباقة", provision: "تسجيل شركة جديدة", owner: "مالك الحساب", darkMode: "الوضع الليلي", language: "English",
  postedOk: "تم ترحيل القيد", savedOk: "تم الحفظ", sodHint: "فصل المهام مفعّل: لا يمكنك ترحيل قيد أنشأته بنفسك.", drillHint: "اضغط على الحساب لعرض دفتر الأستاذ",
  entriesAwaiting: "قيود بانتظار الترحيل", accountsCount: "حسابات الدليل", usersCount: "المستخدمون النشطون", daysLeft: "يوم متبقٍ", currentPeriod: "الفترة الحالية",
  roadmap: "خارطة الطريق", modulesInPlan: "الوحدات في باقتك", entity: "الكيان", actor: "المنفّذ", action: "العملية", details: "التفاصيل", currency: "العملة",
  fxRate: "سعر الصرف", reference: "المرجع", source: "المصدر", required: "مطلوب", close: "إغلاق", mfa: "التحقق الثنائي", enabled: "مفعّل", disabled: "غير مفعّل",
  shortcuts: "اختصارات: N قيد جديد · / بحث",
};
type Dict = typeof ar;
const en: Dict = {
  app: "GOLDEN ERP", tagline: "Enterprise Resource Planning", login: "Sign in", logout: "Sign out", tenant: "Company code", email: "Email",
  password: "Password", otp: "Verification code (6 digits)", signingIn: "Signing in…", dashboard: "Dashboard", users: "Users", roles: "Roles & permissions",
  organization: "Companies, branches & warehouses", coa: "Chart of accounts", journal: "Journal entries", trialBalance: "Trial balance", periods: "Fiscal years & periods",
  audit: "Audit log", subscription: "Subscription", settings: "Settings", groupAdmin: "Administration", groupFinance: "Finance & accounting",
  save: "Save", cancel: "Cancel", create: "Create", add: "Add", search: "Search…", loading: "Loading…", none: "Nothing here yet", confirm: "Confirm",
  active: "Active", inactive: "Inactive", status: "Status", name: "Name", code: "Code", type: "Type", actions: "Actions", date: "Date", memo: "Memo",
  debit: "Debit", credit: "Credit", balance: "Balance", total: "Total", account: "Account", number: "Number", draft: "Draft", posted: "Posted", reversed: "Reversed",
  post: "Post", reverse: "Reverse", delete: "Delete", newEntry: "New entry", addLine: "Add line", difference: "Difference", balanced: "Balanced", unbalanced: "Unbalanced",
  opening: "Opening", movement: "Period movement", closing: "Closing", from: "From", to: "To", show: "Show", ledger: "Ledger", company: "Company",
  branch: "Branch", warehouse: "Warehouse", branches: "Branches", warehouses: "Warehouses", companies: "Companies", kind: "Kind", sellable: "Sellable",
  fullName: "Full name", role: "Role", lastLogin: "Last login", permissions: "Permissions", seedCoa: "Create suggested chart (for review)",
  coaEmpty: "This company has no chart of accounts yet.", coaTemplateNote: "The suggested chart is a starting point that the company accountant must review and approve.",
  closePeriod: "Close", reopenPeriod: "Reopen", open: "Open", closed: "Closed", reason: "Reason", plan: "Plan", usage: "Usage", limit: "Limit",
  invoices: "Invoices", amount: "Amount", demo: "Demo", platform: "Platform admin", tenants: "Tenants", plans: "Plans", suspend: "Suspend",
  reactivate: "Reactivate", changePlan: "Change plan", provision: "Provision tenant", owner: "Owner", darkMode: "Dark mode", language: "العربية",
  postedOk: "Entry posted", savedOk: "Saved", sodHint: "Segregation of duties is on: you cannot post an entry you created.", drillHint: "Click an account to open its ledger",
  entriesAwaiting: "Entries awaiting posting", accountsCount: "Accounts", usersCount: "Active users", daysLeft: "days left", currentPeriod: "Current period",
  roadmap: "Roadmap", modulesInPlan: "Modules in your plan", entity: "Entity", actor: "Actor", action: "Action", details: "Details", currency: "Currency",
  fxRate: "FX rate", reference: "Reference", source: "Source", required: "required", close: "Close", mfa: "MFA", enabled: "On", disabled: "Off",
  shortcuts: "Shortcuts: N new entry · / search",
};

type Lang = "ar" | "en";
const Ctx = createContext<{ t: Dict; lang: Lang; setLang: (l: Lang) => void; pick: (ar?: string | null, en?: string | null) => string }>(null as any);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(() => { try { return (localStorage.getItem("lang") as Lang) || "ar"; } catch { return "ar"; } });
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    try { localStorage.setItem("lang", lang); } catch { /* storage unavailable: preference not persisted */ }
  }, [lang]);
  const pick = (a?: string | null, e?: string | null) => (lang === "ar" ? a || e : e || a) || "";
  return <Ctx.Provider value={{ t: lang === "ar" ? ar : en, lang, setLang, pick }}>{children}</Ctx.Provider>;
}
export const useI18n = () => useContext(Ctx);
