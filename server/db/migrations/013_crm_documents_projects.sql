-- =====================================================================
-- GOLDEN ERP — Migration 013: CRM, documents & approvals, projects (Phase 6d)
-- =====================================================================

-- ------------------------------------------------------------------ CRM
CREATE TABLE crm_campaigns (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  company_id  uuid NOT NULL,
  name        text NOT NULL,
  channel     text NOT NULL CHECK (channel IN ('field', 'social', 'whatsapp', 'sms', 'radio_tv', 'exhibition', 'other')),
  start_date  date NOT NULL,
  end_date    date,
  budget      numeric(20,4) NOT NULL DEFAULT 0 CHECK (budget >= 0),
  notes       text,
  created_by  uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE TYPE lead_status AS ENUM ('new', 'contacted', 'qualified', 'converted', 'lost');
CREATE TABLE crm_leads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  company_id    uuid NOT NULL,
  name          text NOT NULL,                -- contact person
  business_name text,                         -- shop / restaurant / distributor
  phone         text,
  email         text,
  city          text,
  source        text NOT NULL DEFAULT 'other' CHECK (source IN ('rep_visit', 'referral', 'campaign', 'website', 'phone', 'exhibition', 'other')),
  campaign_id   uuid,
  status        lead_status NOT NULL DEFAULT 'new',
  owner_id      uuid,
  lost_reason   text,
  customer_id   uuid,                         -- set on conversion
  notes         text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, campaign_id) REFERENCES crm_campaigns(tenant_id, id),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES parties(tenant_id, id),
  CHECK (status <> 'converted' OR customer_id IS NOT NULL),
  CHECK (status <> 'lost' OR lost_reason IS NOT NULL)
);

CREATE TYPE opp_stage AS ENUM ('prospecting', 'proposal', 'negotiation', 'won', 'lost');
CREATE TABLE crm_opportunities (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  company_id     uuid NOT NULL,
  title          text NOT NULL,
  lead_id        uuid,
  customer_id    uuid,
  stage          opp_stage NOT NULL DEFAULT 'prospecting',
  expected_value numeric(20,4) NOT NULL DEFAULT 0 CHECK (expected_value >= 0),
  probability    smallint NOT NULL DEFAULT 10 CHECK (probability BETWEEN 0 AND 100),
  expected_close date,
  owner_id       uuid,
  lost_reason    text,
  closed_at      timestamptz,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES crm_leads(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES parties(tenant_id, id),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES users(tenant_id, id),
  CHECK (lead_id IS NOT NULL OR customer_id IS NOT NULL),
  CHECK (stage <> 'lost' OR lost_reason IS NOT NULL)
);

CREATE TYPE activity_kind AS ENUM ('call', 'meeting', 'visit', 'task', 'email', 'note');
CREATE TABLE crm_activities (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  company_id     uuid NOT NULL,
  kind           activity_kind NOT NULL,
  subject        text NOT NULL,
  details        text,
  due_at         timestamptz,
  done_at        timestamptz,
  lead_id        uuid,
  opportunity_id uuid,
  customer_id    uuid,
  ticket_id      uuid,
  owner_id       uuid NOT NULL,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES crm_leads(tenant_id, id),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES crm_opportunities(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES parties(tenant_id, id),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES users(tenant_id, id)
);
CREATE INDEX ix_crm_activities_owner ON crm_activities (owner_id, done_at, due_at);

CREATE TYPE ticket_kind AS ENUM ('complaint', 'inquiry', 'service', 'suggestion');
CREATE TYPE ticket_status AS ENUM ('open', 'in_progress', 'resolved', 'closed');
CREATE TABLE crm_tickets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  company_id    uuid NOT NULL,
  number        text NOT NULL,
  customer_id   uuid NOT NULL,
  kind          ticket_kind NOT NULL,
  priority      wo_priority NOT NULL DEFAULT 'normal',
  subject       text NOT NULL,
  description   text,
  lot_id        uuid,                         -- product complaint about a lot → links to traceability
  ncr_id        uuid,                         -- non-conformance opened from the complaint
  status        ticket_status NOT NULL DEFAULT 'open',
  assigned_to   uuid,
  due_at        timestamptz NOT NULL,         -- SLA by priority
  resolution    text,
  resolved_at   timestamptz,
  csat_score    smallint CHECK (csat_score BETWEEN 1 AND 5),
  csat_comment  text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, number),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES parties(tenant_id, id),
  FOREIGN KEY (tenant_id, lot_id) REFERENCES lots(tenant_id, id),
  FOREIGN KEY (tenant_id, ncr_id) REFERENCES nonconformances(tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_to) REFERENCES users(tenant_id, id),
  CHECK (status NOT IN ('resolved', 'closed') OR (resolution IS NOT NULL AND resolved_at IS NOT NULL)),
  CHECK (csat_score IS NULL OR status IN ('resolved', 'closed'))
);
ALTER TABLE crm_activities ADD FOREIGN KEY (tenant_id, ticket_id) REFERENCES crm_tickets(tenant_id, id);

-- ------------------------------------------------------------------ documents
CREATE TABLE documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  company_id      uuid NOT NULL,
  title           text NOT NULL,
  category        text NOT NULL CHECK (category IN ('contract', 'invoice', 'certificate', 'license', 'policy', 'quality', 'hr', 'other')),
  entity_type     text CHECK (entity_type ~ '^[a-z_]{2,40}$'),   -- attached to any record (customer, supplier, asset, employee, lot…)
  entity_id       uuid,
  restricted      boolean NOT NULL DEFAULT false,               -- needs documents.restricted.view
  tags            text[] NOT NULL DEFAULT '{}',
  expires_on      date,                                         -- licences, supplier certificates, contracts
  current_version int NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  CHECK ((entity_type IS NULL) = (entity_id IS NULL))
);
CREATE INDEX ix_documents_entity ON documents (entity_type, entity_id);
CREATE INDEX ix_documents_company ON documents (company_id, status, expires_on);

CREATE TABLE document_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  document_id uuid NOT NULL,
  version     int NOT NULL CHECK (version > 0),
  file_name   text NOT NULL,
  mime_type   text NOT NULL,
  size_bytes  int NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  sha256      char(64) NOT NULL,
  content     bytea NOT NULL,
  note        text,
  uploaded_by uuid,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (document_id, version),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents(tenant_id, id)
);
-- versions are evidence: never changed or removed
CREATE OR REPLACE FUNCTION trg_doc_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'document versions are immutable'; END $$;
CREATE TRIGGER doc_version_guard BEFORE UPDATE OR DELETE ON document_versions FOR EACH ROW EXECUTE FUNCTION trg_doc_version_guard();

-- ------------------------------------------------------------------ approvals (generic, multi-step)
CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'rejected', 'cancelled');
CREATE TABLE approval_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  company_id   uuid NOT NULL,
  title        text NOT NULL,
  entity_type  text NOT NULL CHECK (entity_type ~ '^[a-z_]{2,40}$'),
  entity_id    uuid NOT NULL,
  document_version_id uuid,                -- what exactly is being approved (hash recorded per decision)
  amount       numeric(20,4),
  status       approval_status NOT NULL DEFAULT 'pending',
  current_step smallint NOT NULL DEFAULT 1,
  requested_by uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, document_version_id) REFERENCES document_versions(tenant_id, id)
);
CREATE UNIQUE INDEX uq_approval_pending_entity ON approval_requests (entity_type, entity_id) WHERE status = 'pending';

CREATE TABLE approval_steps (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  request_id     uuid NOT NULL,
  seq            smallint NOT NULL CHECK (seq > 0),
  approver_role_id uuid,
  approver_user_id uuid,
  status         approval_status NOT NULL DEFAULT 'pending',
  decided_by     uuid,
  decided_at     timestamptz,
  comment        text,
  evidence_sha256 char(64),                -- hash of the approved file version at the moment of decision
  UNIQUE (request_id, seq),
  FOREIGN KEY (tenant_id, request_id) REFERENCES approval_requests(tenant_id, id),
  FOREIGN KEY (tenant_id, approver_role_id) REFERENCES roles(tenant_id, id),
  FOREIGN KEY (tenant_id, approver_user_id) REFERENCES users(tenant_id, id),
  CHECK ((approver_role_id IS NULL) <> (approver_user_id IS NULL))
);
CREATE OR REPLACE FUNCTION trg_approval_step_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'approval steps cannot be deleted'; END IF;
  IF OLD.status <> 'pending' THEN RAISE EXCEPTION 'a decided approval step is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_step_guard BEFORE UPDATE OR DELETE ON approval_steps FOR EACH ROW EXECUTE FUNCTION trg_approval_step_guard();

-- ------------------------------------------------------------------ projects
CREATE TYPE project_status AS ENUM ('planned', 'active', 'on_hold', 'done', 'cancelled');
CREATE TABLE projects (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  company_id     uuid NOT NULL,
  code           text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{1,20}$'),
  name_ar        text NOT NULL,
  description    text,
  customer_id    uuid,
  manager_id     uuid NOT NULL,
  start_date     date NOT NULL,
  end_date       date,
  budget         numeric(20,4) NOT NULL DEFAULT 0 CHECK (budget >= 0),
  status         project_status NOT NULL DEFAULT 'planned',
  cost_center_id uuid NOT NULL,             -- actual costs = GL lines on this cost centre
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (company_id, code),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES parties(tenant_id, id),
  FOREIGN KEY (tenant_id, manager_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, cost_center_id) REFERENCES cost_centers(tenant_id, id),
  CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE TYPE task_status AS ENUM ('todo', 'doing', 'blocked', 'done');
CREATE TABLE project_tasks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  project_id     uuid NOT NULL,
  title          text NOT NULL,
  assignee_id    uuid,
  start_date     date,
  due_date       date,
  status         task_status NOT NULL DEFAULT 'todo',
  progress_pct   smallint NOT NULL DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),
  estimate_hours numeric(10,2) NOT NULL DEFAULT 1 CHECK (estimate_hours > 0),
  budget         numeric(20,4) NOT NULL DEFAULT 0 CHECK (budget >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id),
  FOREIGN KEY (tenant_id, assignee_id) REFERENCES users(tenant_id, id),
  CHECK (status <> 'done' OR progress_pct = 100)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['crm_campaigns','crm_leads','crm_opportunities','crm_activities','crm_tickets','documents','document_versions',
                           'approval_requests','approval_steps','projects','project_tasks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY p_tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO golden_app', t);
  END LOOP;
END $$;
REVOKE UPDATE, DELETE ON document_versions FROM golden_app;

INSERT INTO permissions (code, module_code, name_ar, name_en, is_sensitive) VALUES
  ('crm.view',                'crm', 'عرض العملاء المحتملين والفرص والأنشطة والتذاكر', 'View leads, opportunities, activities, tickets', false),
  ('crm.manage',              'crm', 'إدارة العملاء المحتملين والفرص والحملات والأنشطة', 'Manage leads, opportunities, campaigns, activities', false),
  ('crm.tickets.manage',      'crm', 'خدمة العملاء: الشكاوى والتذاكر', 'Customer service: complaints & tickets', false),
  ('documents.view',          'documents', 'عرض المستندات وتنزيلها', 'View & download documents', false),
  ('documents.manage',        'documents', 'رفع المستندات وإصداراتها وأرشفتها', 'Upload documents & versions, archive', false),
  ('documents.restricted.view', 'documents', 'المستندات السرية (عقود، رواتب…)', 'Restricted documents (contracts, salaries…)', true),
  ('documents.approvals.request', 'documents', 'طلب اعتماد إلكتروني', 'Request e-approval', false),
  ('projects.view',           'projects', 'عرض المشاريع والمهام', 'View projects & tasks', false),
  ('projects.manage',         'projects', 'إدارة المشاريع والميزانيات والمهام', 'Manage projects, budgets & tasks', false);
