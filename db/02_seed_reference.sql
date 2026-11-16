-- =====================================================================
--  HVAC BOQ Builder: reference data (file 2 of 3)
--  Roles, permissions, brands and company defaults. Safe to re-run.
-- =====================================================================
BEGIN;

INSERT INTO permissions (code, module, description) VALUES
  ('iam.users.view', 'iam', 'See the list of users'),
  ('iam.users.manage', 'iam', 'Invite, edit, lock and remove users'),
  ('iam.roles.manage', 'iam', 'Change roles and what each role may do'),
  ('settings.company.manage', 'settings', 'Edit company details and BOQ defaults'),
  ('settings.rates.manage', 'settings', 'Record exchange rates'),
  ('catalog.view', 'catalog', 'See brands, products and price lists'),
  ('catalog.cost.view', 'catalog', 'See cost prices (not only selling rates)'),
  ('catalog.edit', 'catalog', 'Add, edit and delete products and prices'),
  ('catalog.price_lists.publish', 'catalog', 'Import a price-list file and make it active'),
  ('crm.clients.view', 'crm', 'See clients'),
  ('crm.clients.manage', 'crm', 'Add and edit clients'),
  ('crm.projects.view', 'crm', 'See projects'),
  ('crm.projects.manage', 'crm', 'Add and edit projects'),
  ('boq.view', 'boq', 'Open BOQs and offers'),
  ('boq.create', 'boq', 'Create BOQs and revisions'),
  ('boq.edit_own', 'boq', 'Edit BOQs you created while they are drafts'),
  ('boq.edit_any', 'boq', 'Edit any draft BOQ'),
  ('boq.delete', 'boq', 'Delete draft BOQs'),
  ('boq.discount.give', 'boq', 'Set profit and discount % on a BOQ or a line'),
  ('boq.costing.view', 'boq', 'See cost, profit and the internal costing sheet'),
  ('boq.approve', 'boq', 'Approve a BOQ so it can be sent'),
  ('boq.export', 'boq', 'Export BOQ and offer files'),
  ('audit.view', 'audit', 'Read the change log')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

INSERT INTO roles (code, name, description, is_system) VALUES
  ('admin', 'Administrator', 'Everything, including users and roles', true),
  ('manager', 'Manager', 'Runs sales: price lists, approvals, all BOQs', true),
  ('estimator', 'Estimator', 'Sales or design engineer who prepares BOQs', true),
  ('viewer', 'Viewer', 'Read-only access to offers', true)
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description;

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, v.perm FROM (VALUES
  ('admin', 'iam.users.view'),
  ('admin', 'iam.users.manage'),
  ('admin', 'iam.roles.manage'),
  ('admin', 'settings.company.manage'),
  ('admin', 'settings.rates.manage'),
  ('admin', 'catalog.view'),
  ('admin', 'catalog.cost.view'),
  ('admin', 'catalog.edit'),
  ('admin', 'catalog.price_lists.publish'),
  ('admin', 'crm.clients.view'),
  ('admin', 'crm.clients.manage'),
  ('admin', 'crm.projects.view'),
  ('admin', 'crm.projects.manage'),
  ('admin', 'boq.view'),
  ('admin', 'boq.create'),
  ('admin', 'boq.edit_own'),
  ('admin', 'boq.edit_any'),
  ('admin', 'boq.delete'),
  ('admin', 'boq.discount.give'),
  ('admin', 'boq.costing.view'),
  ('admin', 'boq.approve'),
  ('admin', 'boq.export'),
  ('admin', 'audit.view'),
  ('manager', 'iam.users.view'),
  ('manager', 'settings.rates.manage'),
  ('manager', 'catalog.view'),
  ('manager', 'catalog.cost.view'),
  ('manager', 'catalog.edit'),
  ('manager', 'catalog.price_lists.publish'),
  ('manager', 'crm.clients.view'),
  ('manager', 'crm.clients.manage'),
  ('manager', 'crm.projects.view'),
  ('manager', 'crm.projects.manage'),
  ('manager', 'boq.view'),
  ('manager', 'boq.create'),
  ('manager', 'boq.edit_own'),
  ('manager', 'boq.edit_any'),
  ('manager', 'boq.delete'),
  ('manager', 'boq.discount.give'),
  ('manager', 'boq.costing.view'),
  ('manager', 'boq.approve'),
  ('manager', 'boq.export'),
  ('manager', 'audit.view'),
  ('estimator', 'catalog.view'),
  ('estimator', 'catalog.cost.view'),
  ('estimator', 'crm.clients.view'),
  ('estimator', 'crm.clients.manage'),
  ('estimator', 'crm.projects.view'),
  ('estimator', 'crm.projects.manage'),
  ('estimator', 'boq.view'),
  ('estimator', 'boq.create'),
  ('estimator', 'boq.edit_own'),
  ('estimator', 'boq.discount.give'),
  ('estimator', 'boq.costing.view'),
  ('estimator', 'boq.export'),
  ('viewer', 'catalog.view'),
  ('viewer', 'crm.clients.view'),
  ('viewer', 'crm.projects.view'),
  ('viewer', 'boq.view')
) AS v(role_code, perm) JOIN roles r ON r.code = v.role_code
ON CONFLICT DO NOTHING;

INSERT INTO brands (code, name, full_name, type_lines, sort_order) VALUES
  ('LG', 'LG', 'LG VRF', ARRAY['Brand : LG']::text[], 1),
  ('DAIKIN', 'Daikin', 'Daikin VRV A', '{}'::text[], 2),
  ('DB', 'DB', 'Dunham-Bush VRF', '{}'::text[], 3)
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, full_name = EXCLUDED.full_name, type_lines = EXCLUDED.type_lines;

INSERT INTO company_settings (id, company_name) VALUES (1, 'Your company name (edit in Settings)')
ON CONFLICT (id) DO NOTHING;

INSERT INTO exchange_rates (currency_from, currency_to, rate, effective_date, source)
VALUES ('USD', 'BDT', 122, DATE '2026-11-01', 'Default used by the BOQ app')
ON CONFLICT DO NOTHING;

-- First administrator: create it from the app's setup screen, or run the lines below with a hash
-- made by the app's password library (argon2id recommended). Never put a plain password here.
-- INSERT INTO app_users (email, full_name, password_hash, email_verified_at)
--   VALUES ('you@yourcompany.com', 'Your Name', '<argon2id hash>', now());
-- INSERT INTO user_roles (user_id, role_id)
--   SELECT u.id, r.id FROM app_users u, roles r WHERE u.email = 'you@yourcompany.com' AND r.code = 'admin';
COMMIT;
