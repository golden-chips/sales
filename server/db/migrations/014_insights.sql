-- =====================================================================
-- GOLDEN ERP — Migration 014: smart insights (Phase 6e)
-- Advisory analytics computed from posted data (statistics + explicit
-- rules). They never post, pay or change anything: a person decides.
-- =====================================================================
INSERT INTO permissions (code, module_code, name_ar, name_en, is_sensitive) VALUES
  ('bi.insights.view',  'bi', 'التحليلات الذكية: الراكد، التنبؤ بالطلب، اقتراحات الشراء والإنتاج، العملاء المنقطعون، انحراف تكلفة الإنتاج', 'Smart insights: slow stock, demand forecast, purchase/production suggestions, lapsed customers, production cost drift', false),
  ('bi.anomalies.view', 'bi', 'اكتشاف القيود والمدفوعات الشاذة (للمراجعة)', 'Unusual journal entries & payments (for review)', true);
