-- Attachments the estimator edited in Excel before sending.
-- source = 'manual' rows are uploaded files, not workbook builds; the sent log shows them as such.
BEGIN;

ALTER TABLE boq_exports ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'generated'
  CHECK (source IN ('generated', 'manual'));
ALTER TABLE boq_exports ADD COLUMN IF NOT EXISTS original_name text;
ALTER TABLE boq_exports ADD COLUMN IF NOT EXISTS sha256 text;

COMMIT;
