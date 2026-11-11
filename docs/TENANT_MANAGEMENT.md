# Tenant Management & Admin Manual

## Platform owner (`/platform`)
| Task | How | Notes |
|---|---|---|
| Sign in | `/platform` with a platform user (seeded from `PLATFORM_ADMIN_*`) | separate identity from tenant users; TOTP supported |
| Plans | Seeded: starter, business, professional, manufacturing, enterprise (prices = 0 placeholders) | `POST /api/v1/platform/plans` to add |
| Provision a tenant | «Provision tenant» | creates tenant, settings, company, HQ branch, 20 system roles, owner user (owner role), subscription (trial if the plan has trial days, otherwise active + first invoice) — all in one transaction |
| Suspend / reactivate / cancel | tenant detail | reason required; suspension revokes all sessions immediately; audited at platform level |
| Change plan | tenant detail | blocked with details if current usage exceeds the target plan's limits; issues an invoice |
| Mark invoice paid | tenant detail → invoices | |
| Lifecycle sweep | «sweep» button or `POST /platform/subscriptions/sweep` (schedule hourly in production) | trial/period end → `past_due` (still usable) → after `grace_days` → `suspended` |
| Usage | tenant detail | counts only — platform staff cannot read tenant business data |

## Tenant administrator
| Task | Where | Permission |
|---|---|---|
| Users: add, roles, branch scope, deactivate, unlock, reset password | Users | `core.users.manage` |
| Roles: view matrix; custom roles & permission replace via API | Roles | `core.roles.*` |
| Branches & warehouses | Companies, branches & warehouses | `core.org.manage` (plan limits apply) |
| Security policy: SoD, MFA required, password length, lockout | `PATCH /api/v1/settings` | `core.settings.manage` |
| Audit trail | Audit log | `core.audit.view` |
| Subscription & invoices | Subscription | `core.subscription.view` |

### System roles
tenant_owner, company_admin, branch_manager, finance_manager, accountant, sales_manager, sales_rep, warehouse_manager, warehouse_worker, production_manager, production_operator, hr_manager, employee, quality_manager, auditor, read_only. (Platform Super Admin is a platform identity, not a tenant role.) Roles for modules that are not built yet receive their permissions automatically when those modules ship (`syncSystemRoles`).

## First tenant — شركة الرقائق الذهبية
Seeded as `golden-chips`: Arabic primary / English secondary, LYD, Africa/Tripoli, Enterprise plan (active), brand colour #7B3F00, suggested chart of accounts (**pending accountant approval**), current fiscal year. **No products, balances, prices or transactions were invented.** A separate tenant `demo-foods` (`is_demo = true`) carries clearly labelled DEMO entries.
