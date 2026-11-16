-- Client rights, split in two:
--   crm.clients.create  -> add a client (admin, manager, estimator; also used by the New BOQ screen)
--   crm.clients.manage  -> edit and remove clients (administrator only)
BEGIN;

INSERT INTO permissions (code, module, description)
VALUES ('crm.clients.create', 'crm', 'Add clients (editing and removing stays with the administrator)')
ON CONFLICT (code) DO NOTHING;

UPDATE permissions
SET description = 'Edit and remove clients (administrator only)'
WHERE code = 'crm.clients.manage';

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, 'crm.clients.create' FROM roles r WHERE r.code IN ('admin', 'manager', 'estimator')
ON CONFLICT DO NOTHING;

DELETE FROM role_permissions rp
USING roles r
WHERE rp.role_id = r.id
  AND rp.permission_code = 'crm.clients.manage'
  AND r.code IN ('manager', 'estimator');

COMMIT;
