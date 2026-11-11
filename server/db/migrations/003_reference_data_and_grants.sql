-- =====================================================================
-- GOLDEN ERP — Migration 003: reference catalogs + least-privilege grants
-- =====================================================================

INSERT INTO currencies (code, name_ar, name_en, minor_units) VALUES
  ('LYD', 'دينار ليبي', 'Libyan Dinar', 3),
  ('USD', 'دولار أمريكي', 'US Dollar', 2),
  ('EUR', 'يورو', 'Euro', 2),
  ('TND', 'دينار تونسي', 'Tunisian Dinar', 3),
  ('EGP', 'جنيه مصري', 'Egyptian Pound', 2),
  ('TRY', 'ليرة تركية', 'Turkish Lira', 2),
  ('SAR', 'ريال سعودي', 'Saudi Riyal', 2),
  ('AED', 'درهم إماراتي', 'UAE Dirham', 2),
  ('CNY', 'يوان صيني', 'Chinese Yuan', 2);

INSERT INTO modules (code, name_ar, name_en, sort_order) VALUES
  ('core',          'الأساسيات والإدارة',      'Core & Administration', 1),
  ('accounting',    'المحاسبة والمالية',        'Financial Management', 2),
  ('sales',         'المبيعات',                 'Sales', 3),
  ('purchasing',    'المشتريات',                'Purchasing', 4),
  ('inventory',     'المخازن',                  'Inventory & Warehouse', 5),
  ('manufacturing', 'التصنيع والإنتاج',         'Manufacturing', 6),
  ('quality',       'الجودة',                   'Quality Management', 7),
  ('distribution',  'المناديب والتوزيع',        'Field Sales & Distribution', 8),
  ('fleet',         'الأسطول والتوصيل',         'Delivery & Fleet', 9),
  ('hr',            'الموارد البشرية والحضور',  'HR & Attendance', 10),
  ('payroll',       'الرواتب',                  'Payroll', 11),
  ('crm',           'إدارة علاقات العملاء',     'CRM', 12),
  ('pos',           'نقاط البيع',               'Point of Sale', 13),
  ('assets',        'الأصول والصيانة',          'Assets & Maintenance', 14),
  ('documents',     'المستندات وسير العمل',     'Documents & Workflow', 15),
  ('projects',      'المشاريع والمهام',          'Projects & Tasks', 16),
  ('bi',            'التقارير وذكاء الأعمال',   'BI & Reporting', 17),
  ('ai',            'المساعد الذكي',            'AI Assistant', 18);

INSERT INTO permissions (code, module_code, name_ar, name_en, is_sensitive) VALUES
  -- core
  ('core.users.view',        'core', 'عرض المستخدمين', 'View users', false),
  ('core.users.manage',      'core', 'إدارة المستخدمين', 'Manage users', true),
  ('core.roles.view',        'core', 'عرض الأدوار', 'View roles', false),
  ('core.roles.manage',      'core', 'إدارة الأدوار والصلاحيات', 'Manage roles & permissions', true),
  ('core.org.view',          'core', 'عرض الشركات والفروع والمخازن', 'View companies, branches, warehouses', false),
  ('core.org.manage',        'core', 'إدارة الشركات والفروع والمخازن', 'Manage companies, branches, warehouses', true),
  ('core.settings.manage',   'core', 'إعدادات الشركة والأمان', 'Tenant & security settings', true),
  ('core.audit.view',        'core', 'عرض سجل التدقيق', 'View audit log', true),
  ('core.subscription.view', 'core', 'عرض الاشتراك والفواتير', 'View subscription & billing', false),
  -- accounting
  ('accounting.accounts.view',    'accounting', 'عرض دليل الحسابات', 'View chart of accounts', false),
  ('accounting.accounts.manage',  'accounting', 'إدارة دليل الحسابات', 'Manage chart of accounts', true),
  ('accounting.journal.view',     'accounting', 'عرض القيود', 'View journal entries', false),
  ('accounting.journal.create',   'accounting', 'إنشاء قيود يومية', 'Create journal entries', false),
  ('accounting.journal.post',     'accounting', 'ترحيل القيود', 'Post journal entries', true),
  ('accounting.journal.reverse',  'accounting', 'عكس القيود المرحلة', 'Reverse posted entries', true),
  ('accounting.periods.manage',   'accounting', 'إدارة السنوات والفترات المالية وإقفالها', 'Manage & close fiscal periods', true),
  ('accounting.reports.view',     'accounting', 'التقارير المالية', 'Financial reports', false),
  ('accounting.cost_centers.manage', 'accounting', 'إدارة مراكز التكلفة', 'Manage cost centers', false),
  ('accounting.fx.manage',        'accounting', 'أسعار الصرف', 'Manage exchange rates', false);

-- ---------------------------------------------------------------------
-- Grants: golden_app gets DML on tenant tables, read-only on catalogs,
-- insert-only on append-only logs. RLS still applies to every query.
-- ---------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO golden_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO golden_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO golden_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO golden_app;

REVOKE INSERT, UPDATE, DELETE ON currencies, modules, permissions FROM golden_app;
REVOKE UPDATE, DELETE ON audit_log, login_attempts, subscription_events FROM golden_app;
REVOKE ALL ON schema_migrations FROM golden_app;
