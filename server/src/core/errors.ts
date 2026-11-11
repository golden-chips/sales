// Every API error has a stable machine code plus Arabic and English messages.
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    public readonly messageAr: string,
    messageEn: string,
    public readonly details?: unknown,
  ) {
    super(messageEn);
  }
}

export const E = {
  unauthenticated: () => new AppError(401, "UNAUTHENTICATED", "يجب تسجيل الدخول", "Authentication required"),
  invalidCredentials: () => new AppError(401, "INVALID_CREDENTIALS", "بيانات الدخول غير صحيحة", "Invalid credentials"),
  mfaRequired: () => new AppError(401, "MFA_REQUIRED", "مطلوب رمز التحقق الثنائي", "MFA code required"),
  locked: (until: string) => new AppError(423, "ACCOUNT_LOCKED", "الحساب مقفل مؤقتًا بسبب محاولات دخول فاشلة", "Account temporarily locked", { until }),
  forbidden: (perm?: string) => new AppError(403, "FORBIDDEN", "ليست لديك صلاحية لهذه العملية", "You do not have permission for this action", perm ? { permission: perm } : undefined),
  tenantSuspended: (status: string) => new AppError(403, "TENANT_SUSPENDED", "حساب الشركة موقوف — تواصل مع إدارة المنصة", "Company account is not active", { status }),
  moduleNotInPlan: (m: string) => new AppError(402, "MODULE_NOT_IN_PLAN", "هذه الوحدة غير مشمولة في باقة الاشتراك", "Module not included in subscription plan", { module: m }),
  planLimit: (what: string, limit: number) => new AppError(402, "PLAN_LIMIT_REACHED", `تم بلوغ الحد الأقصى المسموح في الباقة (${what}: ${limit})`, `Plan limit reached (${what}: ${limit})`, { what, limit }),
  notFound: (what: string) => new AppError(404, "NOT_FOUND", "العنصر غير موجود", `${what} not found`),
  conflict: (msgAr: string, msgEn: string, details?: unknown) => new AppError(409, "CONFLICT", msgAr, msgEn, details),
  validation: (details: unknown) => new AppError(422, "VALIDATION_FAILED", "البيانات المدخلة غير صحيحة", "Validation failed", details),
  rule: (code: string, msgAr: string, msgEn: string, details?: unknown) => new AppError(422, code, msgAr, msgEn, details),
  sod: () => new AppError(403, "SEGREGATION_OF_DUTIES", "لا يمكنك اعتماد/ترحيل مستند أنشأته بنفسك (فصل المهام)", "Segregation of duties: you cannot approve/post your own document"),
};
