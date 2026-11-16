-- =====================================================================
--  File 8: a reply whose BOQ is deleted goes back to the Unmatched list (boq_id becomes NULL via the FK)
--  instead of making the delete fail. match_method stays as history of how it was first matched.
-- =====================================================================
BEGIN;
ALTER TABLE inbound_messages DROP CONSTRAINT IF EXISTS inbound_matched;
ALTER TABLE inbound_messages ADD CONSTRAINT inbound_matched CHECK (boq_id IS NULL OR match_method IS NOT NULL);
COMMIT;
