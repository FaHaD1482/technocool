-- =====================================================================
--  HVAC BOQ Builder: PostgreSQL schema (PostgreSQL 15 or newer)
--  File 1 of 3. Run order: 01_schema.sql, 02_seed_reference.sql, 03_seed_price_lists.sql
--
--  Modules
--    1. Identity and access  users, roles, permissions, sessions, one-time tokens
--    2. Company settings     defaults for new BOQs, exchange-rate history, document numbers
--    3. Catalog              brands, product groups and types, products, versioned price lists
--    4. Clients and projects
--    5. BOQ                  BOQs with revisions, BOQ lines (snapshots), status history, exports
--    6. Audit                row-level change log filled by triggers
--    7. Reporting views      line amounts, brand totals (line A only), offer totals
--
--  Conventions
--    * uuid primary keys for business rows; small integer keys for lookups (roles, brands)
--    * text + CHECK instead of ENUM types, so new values need no type migration
--    * money numeric(14,2), percent numeric(7,3), quantity numeric(14,3), exchange rate numeric(12,4)
--    * created_at / updated_at on every table; updated_at kept by trigger
--    * soft delete (deleted_at) on rows people may want back: products, clients, projects, BOQs
--    * the application sets the acting user per transaction:  SET LOCAL app.user_id = '<uuid>';
--      triggers read it for audit_log and updated_by
-- =====================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;      -- case-insensitive e-mail addresses
CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_uuid() on older servers, digest() for token hashes

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION trg_set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- =====================================================================
-- 1. IDENTITY AND ACCESS
-- =====================================================================
CREATE TABLE app_users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               citext NOT NULL UNIQUE,
  password_hash       text,                          -- argon2id or bcrypt hash made by the app; NULL until an invite is accepted
  full_name           text NOT NULL,
  phone               text,
  designation         text,                          -- e.g. Sales Engineer
  is_active           boolean NOT NULL DEFAULT true,
  email_verified_at   timestamptz,
  last_login_at       timestamptz,
  failed_login_count  integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until        timestamptz,                   -- set after too many failed logins
  created_by          uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_users_email_format CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);
COMMENT ON TABLE app_users IS 'People who sign in. Passwords are never stored, only a slow hash made by the application.';

CREATE TABLE roles (
  id           smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code         text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  name         text NOT NULL,
  description  text,
  is_system    boolean NOT NULL DEFAULT false,         -- system roles cannot be deleted from the UI
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  code         text PRIMARY KEY CHECK (code ~ '^[a-z]+(\.[a-z_]+)+$'),   -- module.action, e.g. boq.export
  module       text NOT NULL,                          -- iam, settings, catalog, crm, boq, audit (inventory later)
  description  text NOT NULL
);

CREATE TABLE role_permissions (
  role_id          smallint NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code  text     NOT NULL REFERENCES permissions(code) ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE user_roles (
  user_id     uuid     NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  role_id     smallint NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  granted_by  uuid REFERENCES app_users(id) ON DELETE SET NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE user_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  refresh_token_hash  text NOT NULL UNIQUE,            -- SHA-256 of the refresh token, never the token itself
  user_agent          text,
  ip_address          inet,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  revoked_reason      text,
  CONSTRAINT user_sessions_expiry CHECK (expires_at > created_at)
);
CREATE INDEX user_sessions_user_active_idx ON user_sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE auth_tokens (                              -- one-time links: password reset, e-mail check, invitation
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  purpose      text NOT NULL CHECK (purpose IN ('password_reset','email_verify','invite')),
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_user_idx ON auth_tokens (user_id, purpose) WHERE used_at IS NULL;

CREATE OR REPLACE FUNCTION user_has_permission(p_user uuid, p_permission text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM app_users u
    JOIN user_roles ur       ON ur.user_id = u.id
    JOIN role_permissions rp ON rp.role_id = ur.role_id
    WHERE u.id = p_user AND u.is_active AND rp.permission_code = p_permission
  )
$$;
COMMENT ON FUNCTION user_has_permission IS 'Use in the API before every action, e.g. user_has_permission(:uid, ''boq.view_costing'').';

-- =====================================================================
-- 2. COMPANY SETTINGS, EXCHANGE RATES, DOCUMENT NUMBERS
-- =====================================================================
CREATE TABLE company_settings (
  id                        smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),     -- exactly one row
  company_name              text NOT NULL,
  address                   text,
  phone                     text,
  email                     citext,
  vat_reg_no                text,                                            -- BIN / VAT registration
  logo_url                  text,
  default_exchange_rate     numeric(12,4) NOT NULL DEFAULT 122    CHECK (default_exchange_rate > 0),
  default_imp_profit_pct    numeric(7,3)  NOT NULL DEFAULT 10     CHECK (default_imp_profit_pct >= 0),
  default_imp_discount_pct  numeric(7,3)  NOT NULL DEFAULT 0      CHECK (default_imp_discount_pct BETWEEN 0 AND 100),
  default_loc_profit_pct    numeric(7,3)  NOT NULL DEFAULT 10     CHECK (default_loc_profit_pct >= 0),
  default_loc_discount_pct  numeric(7,3)  NOT NULL DEFAULT 0      CHECK (default_loc_discount_pct BETWEEN 0 AND 100),
  default_ait_pct           numeric(7,3)  NOT NULL DEFAULT 5      CHECK (default_ait_pct  >= 0 AND default_ait_pct  < 100),
  default_vat_pct           numeric(7,3)  NOT NULL DEFAULT 7.5    CHECK (default_vat_pct  >= 0 AND default_vat_pct  < 100),
  default_tax_method        text          NOT NULL DEFAULT 'gross' CHECK (default_tax_method IN ('gross','simple')),
  default_offer_note        text          NOT NULL DEFAULT 'The above price-offer is estimated. Final bill would be submitted on actual measurement.',
  updated_by                uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE exchange_rates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  currency_from   char(3) NOT NULL DEFAULT 'USD',
  currency_to     char(3) NOT NULL DEFAULT 'BDT',
  rate            numeric(12,4) NOT NULL CHECK (rate > 0),
  effective_date  date NOT NULL,
  source          text,                               -- e.g. bank selling rate
  created_by      uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (currency_from, currency_to, effective_date)
);

CREATE TABLE doc_counters (                             -- gap-free yearly numbers: P-2026-0001, BOQ-2026-0001
  prefix    text    NOT NULL,
  year      integer NOT NULL,
  last_no   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (prefix, year)
);

CREATE OR REPLACE FUNCTION next_doc_no(p_prefix text, p_date date DEFAULT current_date) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v_year int := extract(year FROM p_date); v_no int;
BEGIN
  INSERT INTO doc_counters (prefix, year, last_no) VALUES (p_prefix, v_year, 1)
  ON CONFLICT (prefix, year) DO UPDATE SET last_no = doc_counters.last_no + 1
  RETURNING last_no INTO v_no;
  RETURN format('%s-%s-%s', p_prefix, v_year, lpad(v_no::text, 4, '0'));
END $$;

-- =====================================================================
-- 3. CATALOG
-- =====================================================================
CREATE TABLE brands (
  id          smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]*$'),     -- LG, DAIKIN, DB
  name        text NOT NULL,                                                -- short label: Daikin
  full_name   text NOT NULL,                                                -- Daikin VRV A
  type_lines  text[] NOT NULL DEFAULT '{}',          -- printed under each type when products carry none (LG: Brand : LG)
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE product_groups (                           -- e.g. VRV A System Evaporating Units (Indoor Unit)
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text NOT NULL CHECK (kind IN ('imported','local')),
  brand_id           smallint REFERENCES brands(id) ON DELETE RESTRICT,     -- NULL for local items
  name               text NOT NULL,
  description_lines  text[] NOT NULL DEFAULT '{}',    -- paragraph(s) printed under the group in the BOQ
  sort_order         integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_groups_kind_brand CHECK ((kind = 'imported') = (brand_id IS NOT NULL)),
  UNIQUE NULLS NOT DISTINCT (kind, brand_id, name)
);

CREATE TABLE product_types (                            -- e.g. Ceiling Mounted Duct Type · Wired Remote Controller-BRC1E63
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id      uuid NOT NULL REFERENCES product_groups(id) ON DELETE CASCADE,
  name          text NOT NULL,
  detail_lines  text[] NOT NULL DEFAULT '{}',        -- Refrigerant, Brand, Origin, Assemble, Panel ...
  sort_order    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, name)
);

CREATE TABLE products (                                 -- product master; shared later with inventory
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                 text NOT NULL CHECK (kind IN ('imported','local')),
  brand_id             smallint REFERENCES brands(id) ON DELETE RESTRICT,
  group_id             uuid NOT NULL REFERENCES product_groups(id) ON DELETE RESTRICT,
  type_id              uuid REFERENCES product_types(id) ON DELETE RESTRICT,
  code                 text,                           -- stable key for local items (c14, i38 ...) and future SKU
  model                text,                           -- RXQ24BYM, FXMQ63PAVE ...
  description          text NOT NULL,                  -- Cooling capacity : 24,200 Btu/h / 7.1 kW
  unit                 text NOT NULL DEFAULT 'Nos',
  specs                text[] NOT NULL DEFAULT '{}',
  default_profit_zero  boolean NOT NULL DEFAULT false, -- freight and pass-through charges: 0% profit unless set
  is_active            boolean NOT NULL DEFAULT true,
  created_by           uuid REFERENCES app_users(id) ON DELETE SET NULL,
  updated_by           uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz,
  CONSTRAINT products_kind_brand CHECK ((kind = 'imported') = (brand_id IS NOT NULL)),
  UNIQUE NULLS NOT DISTINCT (brand_id, group_id, type_id, model, description)
);
CREATE UNIQUE INDEX products_code_uq ON products (code) WHERE code IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX products_brand_idx  ON products (brand_id) WHERE deleted_at IS NULL;
CREATE INDEX products_model_idx  ON products (lower(model)) WHERE model IS NOT NULL;
CREATE INDEX products_search_idx ON products USING gin (to_tsvector('simple', coalesce(model,'') || ' ' || description));

CREATE TABLE product_qty_links (                        -- pipe insulation quantity follows the matching pipe sizes
  product_id         uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  source_product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, source_product_id),
  CONSTRAINT product_qty_links_not_self CHECK (product_id <> source_product_id)
);

CREATE TABLE price_lists (                              -- one row per price-list file or revision
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('imported','local')),
  brand_id      smallint REFERENCES brands(id) ON DELETE RESTRICT,
  name          text NOT NULL,                       -- Daikin VRV 6 price list, 29.01.26 (Thailand)
  source_file   text,
  currency      char(3) NOT NULL CHECK (currency IN ('USD','BDT')),
  valid_from    date,
  valid_to      date,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  notes         text,
  published_by  uuid REFERENCES app_users(id) ON DELETE SET NULL,
  published_at  timestamptz,
  created_by    uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT price_lists_kind_brand    CHECK ((kind = 'imported') = (brand_id IS NOT NULL)),
  CONSTRAINT price_lists_kind_currency CHECK ((kind = 'imported' AND currency = 'USD') OR (kind = 'local' AND currency = 'BDT')),
  CONSTRAINT price_lists_dates         CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);
-- only one active list per brand (and one for local items)
CREATE UNIQUE INDEX price_lists_one_active ON price_lists (kind, coalesce(brand_id, 0)) WHERE status = 'active';

CREATE TABLE price_list_items (
  price_list_id  uuid NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
  product_id     uuid NOT NULL REFERENCES products(id)    ON DELETE RESTRICT,
  cost           numeric(14,2) CHECK (cost >= 0),     -- NULL = no price in the source file yet
  sort_order     integer NOT NULL DEFAULT 0,
  updated_by     uuid REFERENCES app_users(id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (price_list_id, product_id)
);
CREATE INDEX price_list_items_order_idx ON price_list_items (price_list_id, sort_order);

-- =====================================================================
-- 4. CLIENTS AND PROJECTS
-- =====================================================================
CREATE TABLE clients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  contact_person  text,
  phone           text,
  email           citext,
  address         text,
  vat_reg_no      text,
  notes           text,
  created_by      uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX clients_name_idx ON clients (lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE projects (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE DEFAULT next_doc_no('P'),
  name           text NOT NULL,
  site_address   text,
  client_id      uuid REFERENCES clients(id) ON DELETE RESTRICT,
  status         text NOT NULL DEFAULT 'lead' CHECK (status IN ('lead','quoted','won','lost','on_hold','completed')),
  owner_user_id  uuid REFERENCES app_users(id) ON DELETE SET NULL,   -- responsible sales engineer
  created_by     uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE INDEX projects_client_idx ON projects (client_id) WHERE deleted_at IS NULL;
CREATE INDEX projects_status_idx ON projects (status)    WHERE deleted_at IS NULL;

-- =====================================================================
-- 5. BOQ
-- =====================================================================
CREATE TABLE boqs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  boq_no             text NOT NULL DEFAULT next_doc_no('BOQ'),     -- same number for every revision
  revision           integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  parent_boq_id      uuid REFERENCES boqs(id) ON DELETE SET NULL,  -- the revision this one was copied from
  title              text,
  status             text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','in_review','approved','sent','accepted','rejected','superseded')),
  selected_brand_id  smallint NOT NULL REFERENCES brands(id),      -- the brand whose line A goes into the offer
  exchange_rate      numeric(12,4) NOT NULL CHECK (exchange_rate > 0),
  imp_profit_pct     numeric(7,3)  NOT NULL CHECK (imp_profit_pct >= 0),
  imp_discount_pct   numeric(7,3)  NOT NULL DEFAULT 0 CHECK (imp_discount_pct BETWEEN 0 AND 100),
  loc_profit_pct     numeric(7,3)  NOT NULL CHECK (loc_profit_pct >= 0),
  loc_discount_pct   numeric(7,3)  NOT NULL DEFAULT 0 CHECK (loc_discount_pct BETWEEN 0 AND 100),
  ait_pct            numeric(7,3)  NOT NULL CHECK (ait_pct >= 0 AND ait_pct < 100),
  vat_pct            numeric(7,3)  NOT NULL CHECK (vat_pct >= 0 AND vat_pct < 100),
  tax_method         text NOT NULL DEFAULT 'gross' CHECK (tax_method IN ('gross','simple')),
  tax_base_a         boolean NOT NULL DEFAULT true,
  tax_base_b         boolean NOT NULL DEFAULT true,
  tax_base_c         boolean NOT NULL DEFAULT true,
  add_tax_to_total   boolean NOT NULL DEFAULT false,   -- false: AIT and VAT are "Provided by the Client"
  offer_currency     text NOT NULL DEFAULT 'BDT' CHECK (offer_currency IN ('BDT','USD')),
  offer_note         text,
  -- cached totals for fast lists; recompute from v_boq_totals whenever lines change
  total_a_bdt        numeric(16,2),
  total_a_usd        numeric(16,2),
  total_b_bdt        numeric(16,2),
  total_c_bdt        numeric(16,2),
  grand_total_bdt    numeric(16,2),
  totals_at          timestamptz,
  approved_by        uuid REFERENCES app_users(id) ON DELETE SET NULL,
  approved_at        timestamptz,
  sent_at            timestamptz,
  created_by         uuid REFERENCES app_users(id) ON DELETE SET NULL,
  updated_by         uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  UNIQUE (boq_no, revision),
  CONSTRAINT boqs_approval CHECK (status NOT IN ('approved','sent','accepted') OR approved_at IS NOT NULL)
);
CREATE INDEX boqs_project_idx ON boqs (project_id) WHERE deleted_at IS NULL;
CREATE INDEX boqs_status_idx  ON boqs (status)     WHERE deleted_at IS NULL;

CREATE TABLE boq_items (                                -- a BOQ line keeps a copy of the product, so later price-list edits never change a sent offer
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  boq_id               uuid NOT NULL REFERENCES boqs(id) ON DELETE CASCADE,
  line                 char(1) NOT NULL CHECK (line IN ('A','B','C')),
  brand_id             smallint REFERENCES brands(id),            -- set for line A, NULL for B and C
  product_id           uuid REFERENCES products(id) ON DELETE SET NULL,   -- NULL for an item added by hand
  price_list_id        uuid REFERENCES price_lists(id) ON DELETE SET NULL,
  is_custom            boolean NOT NULL DEFAULT false,
  is_edited            boolean NOT NULL DEFAULT false,           -- copied fields changed after adding
  group_name           text NOT NULL,
  group_lines          text[] NOT NULL DEFAULT '{}',
  type_name            text,
  type_lines           text[] NOT NULL DEFAULT '{}',
  description          text NOT NULL,
  model                text,
  unit                 text NOT NULL DEFAULT 'Nos',
  specs                text[] NOT NULL DEFAULT '{}',
  cost                 numeric(14,2) CHECK (cost >= 0),          -- USD for line A, Tk for B and C; NULL = no price
  cost_currency        char(3) NOT NULL,
  qty                  numeric(14,3) NOT NULL DEFAULT 0 CHECK (qty >= 0),
  qty_follows_links    boolean NOT NULL DEFAULT false,           -- quantity = sum of linked pipe lines in this BOQ
  profit_pct           numeric(7,3) CHECK (profit_pct >= 0),     -- NULL = BOQ default
  discount_pct         numeric(7,3) CHECK (discount_pct BETWEEN 0 AND 100),  -- NULL = BOQ default
  default_profit_zero  boolean NOT NULL DEFAULT false,
  sort_order           integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT boq_items_line_brand    CHECK ((line = 'A') = (brand_id IS NOT NULL)),
  CONSTRAINT boq_items_line_currency CHECK ((line = 'A' AND cost_currency = 'USD') OR (line IN ('B','C') AND cost_currency = 'BDT')),
  CONSTRAINT boq_items_custom        CHECK (NOT is_custom OR product_id IS NULL)
);
CREATE INDEX boq_items_boq_idx     ON boq_items (boq_id, line, sort_order);
CREATE INDEX boq_items_product_idx ON boq_items (product_id);
-- one line per catalogue product per BOQ (hand-added items are free)
CREATE UNIQUE INDEX boq_items_one_per_product ON boq_items (boq_id, product_id) WHERE product_id IS NOT NULL;

CREATE TABLE boq_status_history (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  boq_id       uuid NOT NULL REFERENCES boqs(id) ON DELETE CASCADE,
  from_status  text,
  to_status    text NOT NULL,
  note         text,
  changed_by   uuid REFERENCES app_users(id) ON DELETE SET NULL,
  changed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX boq_status_history_boq_idx ON boq_status_history (boq_id, changed_at);

CREATE TABLE boq_exports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  boq_id           uuid NOT NULL REFERENCES boqs(id) ON DELETE CASCADE,
  currency         text NOT NULL CHECK (currency IN ('BDT','USD')),
  with_costing     boolean NOT NULL DEFAULT false,
  file_name        text NOT NULL,
  file_url         text,                             -- object storage key if the file is kept
  totals_snapshot  jsonb NOT NULL DEFAULT '{}',      -- what the file showed at export time
  created_by       uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX boq_exports_boq_idx ON boq_exports (boq_id, created_at DESC);

-- status changes are logged automatically
CREATE OR REPLACE FUNCTION trg_boq_status_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO boq_status_history (boq_id, from_status, to_status, changed_by)
    VALUES (NEW.id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status, app_current_user_id());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER boqs_status_history AFTER INSERT OR UPDATE OF status ON boqs
  FOR EACH ROW EXECUTE FUNCTION trg_boq_status_history();

-- =====================================================================
-- 6. AUDIT
-- =====================================================================
CREATE TABLE audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  user_id      uuid,                                  -- no FK: the log outlives deleted users
  action       text NOT NULL,                         -- INSERT, UPDATE, DELETE, or app events: LOGIN, EXPORT ...
  entity       text NOT NULL,                         -- table or object name
  entity_id    text,
  old_data     jsonb,
  new_data     jsonb,
  ip_address   inet,
  user_agent   text
);
CREATE INDEX audit_log_entity_idx ON audit_log (entity, entity_id, occurred_at DESC);
CREATE INDEX audit_log_user_idx   ON audit_log (user_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION trg_audit_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_old jsonb; v_new jsonb; v_id text;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN v_old := to_jsonb(OLD) - 'password_hash'; END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN v_new := to_jsonb(NEW) - 'password_hash'; END IF;
  IF TG_OP = 'UPDATE' AND v_old - 'updated_at' = v_new - 'updated_at' THEN RETURN NEW; END IF;   -- nothing really changed
  v_id := coalesce(coalesce(v_new, v_old) ->> 'id',
                   concat_ws(':', coalesce(v_new, v_old) ->> 'price_list_id', coalesce(v_new, v_old) ->> 'product_id',
                                  coalesce(v_new, v_old) ->> 'user_id',       coalesce(v_new, v_old) ->> 'role_id',
                                  coalesce(v_new, v_old) ->> 'permission_code'));   -- tables with two-part keys
  INSERT INTO audit_log (user_id, action, entity, entity_id, old_data, new_data)
  VALUES (app_current_user_id(), TG_OP, TG_TABLE_NAME, v_id, v_old, v_new);
  RETURN coalesce(NEW, OLD);
END $$;

-- updated_at triggers
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['app_users','roles','company_settings','brands','product_groups','product_types','products',
                           'price_lists','price_list_items','clients','projects','boqs','boq_items']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at()', t, t);
  END LOOP;
END $$;

-- audit triggers on the tables where money or access changes
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['app_users','user_roles','role_permissions','company_settings','products','price_lists',
                           'price_list_items','clients','projects','boqs','boq_items']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_audit AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION trg_audit_row()', t, t);
  END LOOP;
END $$;

-- =====================================================================
-- 7. REPORTING VIEWS  (same rounding as the app)
--    Rate      = round( round(cost × (1 + profit%), 2) × (1 − discount%), 2 )
--    Line A    Rate Tk = round(Rate USD × exchange rate, 2); Amount Tk = Rate Tk × Qty
--    AIT/VAT   gross-up: AIT = base × a ÷ (100 − a); VAT = (base + AIT) × v ÷ (100 − v)
--              simple:   AIT = base × a ÷ 100;      VAT = (base + AIT) × v ÷ 100
-- =====================================================================
CREATE OR REPLACE VIEW v_boq_item_amounts AS
WITH linked AS (                          -- quantity of lines that follow pipe sizes
  SELECT bi.id, sum(src.qty) AS linked_qty
  FROM boq_items bi
  JOIN product_qty_links l ON l.product_id = bi.product_id
  JOIN boq_items src       ON src.boq_id = bi.boq_id AND src.product_id = l.source_product_id
  WHERE bi.qty_follows_links
  GROUP BY bi.id
), base AS (
  SELECT bi.*, b.exchange_rate, b.selected_brand_id,
         CASE WHEN bi.qty_follows_links THEN coalesce(lk.linked_qty, 0) ELSE bi.qty END AS eff_qty,
         coalesce(bi.profit_pct,
                  CASE WHEN bi.default_profit_zero THEN 0
                       WHEN bi.line = 'A' THEN b.imp_profit_pct ELSE b.loc_profit_pct END) AS eff_profit_pct,
         coalesce(bi.discount_pct,
                  CASE WHEN bi.line = 'A' THEN b.imp_discount_pct ELSE b.loc_discount_pct END) AS eff_discount_pct
  FROM boq_items bi
  JOIN boqs b ON b.id = bi.boq_id
  LEFT JOIN linked lk ON lk.id = bi.id
), priced AS (
  SELECT base.*,
         round(round(coalesce(cost,0) * (1 + eff_profit_pct/100), 2) * (1 - eff_discount_pct/100), 2) AS sell_rate,
         round(coalesce(cost,0) * (1 + eff_profit_pct/100), 2) AS list_rate
  FROM base
)
SELECT p.id, p.boq_id, p.line, p.brand_id, p.product_id, p.is_custom, p.sort_order,
       p.group_name, p.type_name, p.description, p.model, p.unit,
       p.cost, p.cost_currency, p.eff_qty AS qty, p.eff_profit_pct AS profit_pct, p.eff_discount_pct AS discount_pct,
       p.cost IS NULL AS missing_price,
       p.sell_rate AS rate,                                                     -- USD for A, Tk for B and C
       CASE WHEN p.line = 'A' THEN round(p.sell_rate * p.exchange_rate, 2) ELSE p.sell_rate END AS rate_bdt,
       CASE WHEN p.line = 'A' THEN p.sell_rate * p.eff_qty END                 AS amount_usd,
       CASE WHEN p.line = 'A' THEN round(p.sell_rate * p.exchange_rate, 2) * p.eff_qty
            ELSE p.sell_rate * p.eff_qty END                                    AS amount_bdt,
       CASE WHEN p.line = 'A' THEN coalesce(p.cost,0) * p.eff_qty * p.exchange_rate
            ELSE coalesce(p.cost,0) * p.eff_qty END                             AS cost_bdt,
       CASE WHEN p.line = 'A' THEN (p.list_rate - p.sell_rate) * p.eff_qty * p.exchange_rate
            ELSE (p.list_rate - p.sell_rate) * p.eff_qty END                    AS discount_bdt,
       (p.line <> 'A' OR p.brand_id = p.selected_brand_id)                      AS counts_in_offer
FROM priced p;
COMMENT ON VIEW v_boq_item_amounts IS 'One row per BOQ line with the effective %, rate and amounts. Line A rows of other brands are kept for comparison but counts_in_offer = false.';

CREATE OR REPLACE VIEW v_boq_brand_totals AS            -- imported items only; local items are never included
SELECT boq_id, brand_id,
       count(*) FILTER (WHERE qty > 0) AS items,
       sum(amount_bdt)                 AS imported_bdt,
       sum(amount_usd)                 AS imported_usd
FROM v_boq_item_amounts
WHERE line = 'A'
GROUP BY boq_id, brand_id;

CREATE OR REPLACE VIEW v_boq_totals AS
WITH s AS (
  SELECT b.id AS boq_id, b.ait_pct, b.vat_pct, b.tax_method, b.tax_base_a, b.tax_base_b, b.tax_base_c, b.add_tax_to_total,
         coalesce(sum(a.amount_bdt) FILTER (WHERE a.line = 'A' AND a.counts_in_offer), 0) AS a_bdt,
         coalesce(sum(a.amount_usd) FILTER (WHERE a.line = 'A' AND a.counts_in_offer), 0) AS a_usd,
         coalesce(sum(a.amount_bdt) FILTER (WHERE a.line = 'B'), 0) AS b_bdt,
         coalesce(sum(a.amount_bdt) FILTER (WHERE a.line = 'C'), 0) AS c_bdt,
         coalesce(sum(a.cost_bdt)   FILTER (WHERE a.counts_in_offer), 0) AS cost_bdt,
         coalesce(sum(a.discount_bdt) FILTER (WHERE a.counts_in_offer), 0) AS discount_bdt
  FROM boqs b LEFT JOIN v_boq_item_amounts a ON a.boq_id = b.id
  GROUP BY b.id
), t AS (
  SELECT s.*,
         (CASE WHEN tax_base_a THEN a_bdt ELSE 0 END + CASE WHEN tax_base_b THEN b_bdt ELSE 0 END + CASE WHEN tax_base_c THEN c_bdt ELSE 0 END) AS base_bdt,
         (CASE WHEN tax_base_b THEN b_bdt ELSE 0 END + CASE WHEN tax_base_c THEN c_bdt ELSE 0 END) AS base_usd_offer   -- USD offer: A is on the client's L.C
  FROM s
), x AS (
  SELECT t.*,
         CASE WHEN tax_method = 'gross' THEN base_bdt * ait_pct / (100 - ait_pct) ELSE base_bdt * ait_pct / 100 END AS ait_bdt,
         CASE WHEN tax_method = 'gross' THEN base_usd_offer * ait_pct / (100 - ait_pct) ELSE base_usd_offer * ait_pct / 100 END AS ait_usd_offer
  FROM t
), y AS (
  SELECT x.*,
         CASE WHEN tax_method = 'gross' THEN (base_bdt + ait_bdt) * vat_pct / (100 - vat_pct) ELSE (base_bdt + ait_bdt) * vat_pct / 100 END AS vat_bdt,
         CASE WHEN tax_method = 'gross' THEN (base_usd_offer + ait_usd_offer) * vat_pct / (100 - vat_pct) ELSE (base_usd_offer + ait_usd_offer) * vat_pct / 100 END AS vat_usd_offer
  FROM x
)
SELECT boq_id,
       round(a_bdt, 2) AS total_a_bdt, round(a_usd, 2) AS total_a_usd, round(b_bdt, 2) AS total_b_bdt, round(c_bdt, 2) AS total_c_bdt,
       round(ait_bdt, 2) AS ait_bdt, round(vat_bdt, 2) AS vat_bdt,
       round(a_bdt + b_bdt + c_bdt + CASE WHEN add_tax_to_total THEN ait_bdt + vat_bdt ELSE 0 END, 2) AS grand_total_bdt,
       -- USD offer: A stays in USD, Taka part is B + C (+ taxes on B and C if added)
       round(ait_usd_offer, 2) AS usd_offer_ait_bdt, round(vat_usd_offer, 2) AS usd_offer_vat_bdt,
       round(b_bdt + c_bdt + CASE WHEN add_tax_to_total THEN ait_usd_offer + vat_usd_offer ELSE 0 END, 2) AS usd_offer_taka_total,
       round(cost_bdt, 2) AS cost_bdt, round(discount_bdt, 2) AS discount_bdt,
       round(a_bdt + b_bdt + c_bdt - cost_bdt, 2) AS profit_bdt
FROM y;

-- refresh the cached totals on boqs (call after saving lines)
CREATE OR REPLACE FUNCTION refresh_boq_totals(p_boq uuid) RETURNS void
LANGUAGE sql AS $$
  UPDATE boqs b SET total_a_bdt = t.total_a_bdt, total_a_usd = t.total_a_usd, total_b_bdt = t.total_b_bdt,
                    total_c_bdt = t.total_c_bdt, grand_total_bdt = t.grand_total_bdt, totals_at = now()
  FROM v_boq_totals t WHERE t.boq_id = b.id AND b.id = p_boq
$$;

-- new revision: copy a BOQ with its lines; the old one becomes superseded
CREATE OR REPLACE FUNCTION create_boq_revision(p_boq uuid) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_new uuid := gen_random_uuid();
BEGIN
  INSERT INTO boqs (id, project_id, boq_no, revision, parent_boq_id, title, status, selected_brand_id, exchange_rate,
                    imp_profit_pct, imp_discount_pct, loc_profit_pct, loc_discount_pct, ait_pct, vat_pct, tax_method,
                    tax_base_a, tax_base_b, tax_base_c, add_tax_to_total, offer_currency, offer_note, created_by, updated_by)
  SELECT v_new, project_id, boq_no, (SELECT max(revision) + 1 FROM boqs x WHERE x.boq_no = b.boq_no), id, title, 'draft',
         selected_brand_id, exchange_rate, imp_profit_pct, imp_discount_pct, loc_profit_pct, loc_discount_pct, ait_pct, vat_pct,
         tax_method, tax_base_a, tax_base_b, tax_base_c, add_tax_to_total, offer_currency, offer_note, app_current_user_id(), app_current_user_id()
  FROM boqs b WHERE id = p_boq;
  IF NOT FOUND THEN RAISE EXCEPTION 'BOQ % not found', p_boq; END IF;

  INSERT INTO boq_items (boq_id, line, brand_id, product_id, price_list_id, is_custom, is_edited, group_name, group_lines, type_name,
                         type_lines, description, model, unit, specs, cost, cost_currency, qty, qty_follows_links, profit_pct,
                         discount_pct, default_profit_zero, sort_order)
  SELECT v_new, line, brand_id, product_id, price_list_id, is_custom, is_edited, group_name, group_lines, type_name, type_lines,
         description, model, unit, specs, cost, cost_currency, qty, qty_follows_links, profit_pct, discount_pct, default_profit_zero, sort_order
  FROM boq_items WHERE boq_id = p_boq;

  UPDATE boqs SET status = 'superseded' WHERE id = p_boq AND status <> 'superseded';
  PERFORM refresh_boq_totals(v_new);
  RETURN v_new;
END $$;

COMMIT;
