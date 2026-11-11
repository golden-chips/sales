# Product Requirements (summary)

**Product:** GOLDEN ERP — multi-tenant SaaS ERP for food manufacturing, trading, wholesale and distribution companies. Arabic-first (RTL), English supported. First operating tenant: شركة الرقائق الذهبية لصناعة المواد الغذائية (LYD, Africa/Tripoli).

**Personas:** platform owner; tenant owner/admin; finance manager & accountant; sales manager & field rep; warehouse manager & worker; production manager & operator; quality manager; HR manager & employee; auditor; read-only.

**Non-negotiables (from the owner's brief):**
1. Real tenant isolation enforced below the UI — no cross-tenant access in any form.
2. Double-entry accounting: no unbalanced posting, no editing posted entries (reversal only), periods & closing, every figure traceable to its source document.
3. Every operational document (sales, purchase, stock, production, payroll) produces its accounting effect through a defined workflow (save → approve → post).
4. Server-side RBAC with branch/warehouse scope and segregation of duties.
5. Full audit trail; no secrets in code; no real customer data in dev/test.
6. Reuse proven logic from the existing van-sales and attendance systems rather than rebuilding it.
7. Documented, tested, honest progress reporting — nothing marked done unless verified.

**Scope:** modules A–P and the SaaS platform as listed in the brief; delivered in phases (see IMPLEMENTATION_PLAN.md) with per-phase acceptance criteria.

**Out of scope until approved:** final accounting policies, tax rates, payroll statutory rates, plan prices, and any real data of the first tenant (see RISKS_AND_DECISIONS.md).
