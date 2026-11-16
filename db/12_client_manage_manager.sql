-- Managers may edit and remove clients as well; the estimator still may not.
BEGIN;

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, 'crm.clients.manage' FROM roles r WHERE r.code = 'manager'
ON CONFLICT DO NOTHING;

COMMIT;
