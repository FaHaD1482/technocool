import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '@/lib/api';
import { can, type SessionUser } from '@/lib/auth/session';
import { calculate } from '@/lib/calc';
import { query, tx, type Db } from '@/lib/db';
import { toCalcRow, toCalcSettings } from './rows';
import type { BoqHeader, BoqRow, BoqSettings, BrandDTO, CatalogEntry, EditorData, EditorPermissions } from './types';

// ---------------------------------------------------------------------
// Visibility: the own-BOQ-only rule, applied in SQL on every read.
// ---------------------------------------------------------------------
/** SQL condition + params that limit boqs (alias b) to what this user may see. */
export function visibleBoqs(u: SessionUser, alias = 'b', paramIndex = 1) {
  if (can(u, 'boq.view_all')) return { sql: 'TRUE', params: [] as unknown[] };
  return { sql: `${alias}.owner_user_id = $${paramIndex}`, params: [u.id] as unknown[] };
}

// ---------------------------------------------------------------------
// Catalogue (active price lists), cached briefly in memory
// ---------------------------------------------------------------------
let catalogCache: { at: number; data: { catalog: CatalogEntry[]; brands: BrandDTO[] } } | null = null;

export async function loadCatalog(): Promise<{ catalog: CatalogEntry[]; brands: BrandDTO[] }> {
  if (catalogCache && Date.now() - catalogCache.at < 60_000) return catalogCache.data;
  const [items, brands] = await Promise.all([
    query(`
      SELECT p.id AS product_id, pl.id AS price_list_id, p.kind, p.brand_id, p.code, p.model, p.description, p.unit, p.specs,
             p.default_profit_zero, g.name AS group_name, g.description_lines AS group_lines,
             t.name AS type_name, t.detail_lines AS type_lines, pli.cost::text AS cost, pli.sort_order,
             coalesce((SELECT array_agg(l.source_product_id::text) FROM product_qty_links l WHERE l.product_id = p.id), '{}') AS link_sources
      FROM price_lists pl
      JOIN price_list_items pli ON pli.price_list_id = pl.id
      JOIN products p ON p.id = pli.product_id AND p.deleted_at IS NULL AND p.is_active
      JOIN product_groups g ON g.id = p.group_id
      LEFT JOIN product_types t ON t.id = p.type_id
      WHERE pl.status = 'active'
      ORDER BY pl.kind, p.brand_id NULLS LAST, pli.sort_order`),
    query(`
      SELECT b.id, b.code, b.name, b.full_name, b.type_lines,
             (SELECT name FROM price_lists pl WHERE pl.brand_id = b.id AND pl.status = 'active' LIMIT 1) AS price_list_name
      FROM brands b WHERE b.is_active ORDER BY b.sort_order`),
  ]);
  const data = {
    catalog: items.rows.map((r): CatalogEntry => ({
      productId: r.product_id, priceListId: r.price_list_id, kind: r.kind, brandId: r.brand_id, code: r.code,
      groupName: r.group_name, groupLines: r.group_lines, typeName: r.type_name, typeLines: r.type_lines ?? [],
      description: r.description, model: r.model, unit: r.unit, specs: r.specs, cost: r.cost,
      defaultProfitZero: r.default_profit_zero, sortOrder: r.sort_order, linkSources: r.link_sources,
    })),
    brands: brands.rows.map((b): BrandDTO => ({
      id: b.id, code: b.code, name: b.name, fullName: b.full_name, typeLines: b.type_lines, priceListName: b.price_list_name,
    })),
  };
  catalogCache = { at: Date.now(), data };
  return data;
}

// ---------------------------------------------------------------------
// Load one BOQ
// ---------------------------------------------------------------------
const HEADER_SQL = `
  SELECT b.*, b.xmin::text AS version, p.code AS project_code, p.name AS project_name, p.site_address,
         c.id AS client_id, c.name AS client_name, c.email AS client_email, u.full_name AS owner_name,
         (SELECT max(revision) FROM boqs x WHERE x.boq_no = b.boq_no AND x.deleted_at IS NULL) AS latest_revision
  FROM boqs b
  JOIN projects p ON p.id = b.project_id
  LEFT JOIN clients c ON c.id = p.client_id
  LEFT JOIN app_users u ON u.id = b.owner_user_id`;

type BoqDbRow = Record<string, any>;

function mapHeader(b: BoqDbRow): BoqHeader {
  return {
    id: b.id, boqNo: b.boq_no, revision: b.revision, latestRevision: b.latest_revision, status: b.status, version: b.version,
    projectId: b.project_id, projectCode: b.project_code, projectName: b.project_name, siteAddress: b.site_address,
    clientId: b.client_id, clientName: b.client_name, clientEmail: b.client_email,
    ownerId: b.owner_user_id, ownerName: b.owner_name,
    sentAt: b.sent_at?.toISOString() ?? null, updatedAt: b.updated_at.toISOString(),
  };
}

function mapSettings(b: BoqDbRow): BoqSettings {
  const n = (v: string) => String(Number(v));   // "10.000" -> "10"
  return {
    title: b.title ?? '', selectedBrandId: b.selected_brand_id, exchangeRate: n(b.exchange_rate),
    impProfitPct: n(b.imp_profit_pct), impDiscountPct: n(b.imp_discount_pct),
    locProfitPct: n(b.loc_profit_pct), locDiscountPct: n(b.loc_discount_pct),
    aitPct: n(b.ait_pct), vatPct: n(b.vat_pct), taxMethod: b.tax_method,
    taxBaseA: b.tax_base_a, taxBaseB: b.tax_base_b, taxBaseC: b.tax_base_c, addTaxToTotal: b.add_tax_to_total,
    offerCurrency: b.offer_currency, offerNote: b.offer_note ?? '',
  };
}

async function loadItems(boqId: string, db?: Db): Promise<BoqRow[]> {
  const run = db ? db.query.bind(db) : query;
  const { rows } = await run(`
    SELECT bi.*, bi.cost::text AS cost_s, bi.qty::text AS qty_s, bi.profit_pct::text AS profit_s, bi.discount_pct::text AS disc_s,
           coalesce((SELECT array_agg(l.source_product_id::text) FROM product_qty_links l WHERE l.product_id = bi.product_id), '{}') AS link_sources
    FROM boq_items bi WHERE bi.boq_id = $1
    ORDER BY bi.line, bi.brand_id NULLS LAST, bi.is_custom, bi.sort_order, bi.created_at`, [boqId]);
  const clean = (v: string | null) => (v === null ? null : String(Number(v)));
  return rows.map((r): BoqRow => ({
    key: r.id, itemId: r.id, productId: r.product_id, priceListId: r.price_list_id, line: r.line, brandId: r.brand_id,
    isCustom: r.is_custom, isEdited: r.is_edited, groupName: r.group_name, groupLines: r.group_lines,
    typeName: r.type_name, typeLines: r.type_lines, description: r.description, model: r.model, unit: r.unit, specs: r.specs,
    cost: clean(r.cost_s), qty: clean(r.qty_s) ?? '0', qtyFollowsLinks: r.qty_follows_links, linkSources: r.link_sources,
    profitPct: clean(r.profit_s), discountPct: clean(r.disc_s), defaultProfitZero: r.default_profit_zero, sortOrder: r.sort_order,
  }));
}

/** Loads a BOQ the user may see, or throws 404 (never reveals that someone else's BOQ exists). */
export async function getVisibleBoq(u: SessionUser, boqId: string): Promise<BoqDbRow> {
  if (!z.uuid().safeParse(boqId).success) throw new ApiError(404, 'BOQ not found.');
  if (!can(u, 'boq.view')) throw new ApiError(403, 'You do not have permission to open BOQs.');
  const v = visibleBoqs(u, 'b', 2);
  const { rows } = await query(`${HEADER_SQL} WHERE b.id = $1 AND b.deleted_at IS NULL AND ${v.sql}`, [boqId, ...v.params]);
  if (!rows[0]) throw new ApiError(404, 'BOQ not found.');
  return rows[0];
}

export function editorPermissions(u: SessionUser, b: BoqDbRow): EditorPermissions {
  const own = b.owner_user_id === u.id;
  const mayEdit = (own && can(u, 'boq.edit_own')) || can(u, 'boq.edit_any');
  const canSeeCost = can(u, 'boq.costing.view');
  let readOnlyReason: string | null = null;
  if (b.status !== 'draft') readOnlyReason = `This BOQ is ${b.status}. Create a new revision to change it.`;
  else if (!mayEdit) readOnlyReason = 'You can view this BOQ but not edit it.';
  else if (!canSeeCost) readOnlyReason = 'Editing needs permission to see costs.';
  const isLatest = b.revision === b.latest_revision;
  return {
    canEdit: readOnlyReason === null,
    canSeeCost,
    canGiveDiscount: can(u, 'boq.discount.give'),
    canExport: can(u, 'boq.export'),
    canExportCosting: can(u, 'boq.export') && canSeeCost,
    canSend: can(u, 'boq.send') && own && b.status === 'draft',
    canRevise: can(u, 'boq.create') && mayEdit && isLatest && b.status !== 'draft',
    readOnlyReason,
  };
}

/**
 * For users without boq.costing.view: the real cost never leaves the server. Each line's "cost" is
 * replaced by its selling rate with 0% profit and 0% discount, so the screen shows the same rates and
 * amounts while cost, profit and discount stay hidden.
 */
function stripCosts(rows: BoqRow[], settings: BoqSettings): BoqRow[] {
  const res = calculate(rows.map(toCalcRow), toCalcSettings(settings));
  return rows.map((r) => {
    const it = res.items.get(r.key)!;
    return { ...r, cost: it.missingPrice ? null : it.rate.toFixed(2), profitPct: '0', discountPct: '0' };
  });
}

export async function loadEditorData(u: SessionUser, boqId: string): Promise<EditorData> {
  const b = await getVisibleBoq(u, boqId);
  const perms = editorPermissions(u, b);
  const [items, { catalog, brands }] = await Promise.all([loadItems(boqId), loadCatalog()]);
  const settings = mapSettings(b);
  return {
    header: mapHeader(b),
    settings: perms.canSeeCost ? settings : { ...settings, impProfitPct: '0', impDiscountPct: '0', locProfitPct: '0', locDiscountPct: '0' },
    rows: perms.canSeeCost ? items : stripCosts(items, settings),
    // Only someone who can edit needs the full price list (with costs).
    catalog: perms.canEdit ? catalog : [],
    brands,
    perms,
  };
}

/** Full data for export / send (server only, costs included). Caller has already checked access. */
export async function loadBoqForServer(boqId: string) {
  const { rows } = await query(`${HEADER_SQL} WHERE b.id = $1 AND b.deleted_at IS NULL`, [boqId]);
  if (!rows[0]) throw new ApiError(404, 'BOQ not found.');
  const [items, { brands }] = await Promise.all([loadItems(boqId), loadCatalog()]);
  return { header: mapHeader(rows[0]), settings: mapSettings(rows[0]), rows: items, brands };
}

// ---------------------------------------------------------------------
// Save (autosave from the editor)
// ---------------------------------------------------------------------
const numStr = (max: number) => z.string().trim().regex(/^\d+(\.\d+)?$/, 'Must be a number').refine((v) => Number(v) <= max, `Must be ≤ ${max}`);
const pct = numStr(1000);
const lines = z.array(z.string().max(2000)).max(50);

const RowSchema = z.object({
  key: z.string().max(80),
  itemId: z.uuid().nullable(),
  productId: z.uuid().nullable(),
  priceListId: z.uuid().nullable(),
  line: z.enum(['A', 'B', 'C']),
  brandId: z.number().int().positive().nullable(),
  isCustom: z.boolean(),
  isEdited: z.boolean(),
  groupName: z.string().trim().min(1).max(300),
  groupLines: lines,
  typeName: z.string().max(300).nullable(),
  typeLines: lines,
  description: z.string().trim().min(1, 'Every line needs a description').max(2000),
  model: z.string().max(200).nullable(),
  unit: z.string().trim().min(1).max(20),
  specs: lines,
  cost: numStr(1e11).nullable(),
  qty: numStr(1e9),
  qtyFollowsLinks: z.boolean(),
  linkSources: z.array(z.string()).max(20),
  profitPct: pct.nullable(),
  discountPct: numStr(100).nullable(),
  defaultProfitZero: z.boolean(),
  sortOrder: z.number().int().min(0).max(1e6),
}).refine((r) => (r.line === 'A') === (r.brandId !== null), 'Line A needs a brand; lines B and C have none')
  .refine((r) => !r.isCustom || r.productId === null, 'A hand-added line has no product');

const SettingsSchema = z.object({
  title: z.string().max(300),
  selectedBrandId: z.number().int().positive(),
  exchangeRate: numStr(100000).refine((v) => Number(v) > 0, 'Exchange rate must be above 0'),
  impProfitPct: pct, impDiscountPct: numStr(100), locProfitPct: pct, locDiscountPct: numStr(100),
  aitPct: numStr(99.999), vatPct: numStr(99.999),
  taxMethod: z.enum(['gross', 'simple']),
  taxBaseA: z.boolean(), taxBaseB: z.boolean(), taxBaseC: z.boolean(), addTaxToTotal: z.boolean(),
  offerCurrency: z.enum(['BDT', 'USD']),
  offerNote: z.string().max(4000),
});

export const SaveSchema = z.object({
  version: z.string().max(40),
  settings: SettingsSchema,
  rows: z.array(RowSchema).max(3000),
}).refine((b) => {
  const ids = b.rows.map((r) => r.productId).filter(Boolean);
  return new Set(ids).size === ids.length;
}, 'A product appears twice');

export type SavePayload = z.infer<typeof SaveSchema>;

export async function saveBoq(u: SessionUser, boqId: string, input: SavePayload) {
  const b = await getVisibleBoq(u, boqId);
  const perms = editorPermissions(u, b);
  if (!perms.canEdit) throw new ApiError(403, perms.readOnlyReason ?? 'You cannot edit this BOQ.');

  return tx(u.id, async (db) => {
    // Optimistic lock: refuse if the BOQ changed since the editor loaded it (another tab or person).
    const cur = await db.query('SELECT xmin::text AS version FROM boqs WHERE id = $1 FOR UPDATE', [boqId]);
    if (cur.rows[0]?.version !== input.version) {
      throw new ApiError(409, 'This BOQ was changed in another window. Reload to get the latest version.', 'stale');
    }

    const s = input.settings;
    const existing = await loadItems(boqId, db);
    const byId = new Map(existing.map((r) => [r.itemId!, r]));

    // Without boq.discount.give, profit and discount stay as they were.
    const keepPct = !perms.canGiveDiscount;
    const settingsPct = keepPct
      ? [b.imp_profit_pct, b.imp_discount_pct, b.loc_profit_pct, b.loc_discount_pct]
      : [s.impProfitPct, s.impDiscountPct, s.locProfitPct, s.locDiscountPct];

    await db.query(
      `UPDATE boqs SET title = NULLIF($2, ''), selected_brand_id = $3, exchange_rate = $4,
         imp_profit_pct = $5, imp_discount_pct = $6, loc_profit_pct = $7, loc_discount_pct = $8,
         ait_pct = $9, vat_pct = $10, tax_method = $11, tax_base_a = $12, tax_base_b = $13, tax_base_c = $14,
         add_tax_to_total = $15, offer_currency = $16, offer_note = $17, updated_by = $18
       WHERE id = $1`,
      [boqId, s.title, s.selectedBrandId, s.exchangeRate, ...settingsPct, s.aitPct, s.vatPct, s.taxMethod,
        s.taxBaseA, s.taxBaseB, s.taxBaseC, s.addTaxToTotal, s.offerCurrency, s.offerNote, u.id],
    );

    const keys: Record<string, string> = {};
    const records = input.rows.map((r) => {
      const prev = r.itemId ? byId.get(r.itemId) : undefined;
      if (r.itemId && !prev) throw new ApiError(400, 'A line does not belong to this BOQ.');
      const id = prev?.itemId ?? randomUUID();
      keys[r.key] = id;
      return {
        id, isNew: !prev,
        line: r.line, brand_id: r.brandId, product_id: r.productId, price_list_id: r.priceListId,
        is_custom: r.isCustom, is_edited: r.isEdited, group_name: r.groupName, group_lines: r.groupLines,
        type_name: r.typeName || null, type_lines: r.typeLines, description: r.description, model: r.model || null,
        unit: r.unit, specs: r.specs, cost: r.cost, cost_currency: r.line === 'A' ? 'USD' : 'BDT', qty: r.qty,
        qty_follows_links: r.qtyFollowsLinks,
        profit_pct: keepPct ? (prev?.profitPct ?? null) : r.profitPct,
        discount_pct: keepPct ? (prev?.discountPct ?? null) : r.discountPct,
        default_profit_zero: r.defaultProfitZero, sort_order: r.sortOrder,
      };
    });

    const keepIds = records.map((r) => r.id);
    await db.query('DELETE FROM boq_items WHERE boq_id = $1 AND NOT (id = ANY($2::uuid[]))', [boqId, keepIds]);

    const cols = `id uuid, line char(1), brand_id smallint, product_id uuid, price_list_id uuid, is_custom boolean,
      is_edited boolean, group_name text, group_lines text[], type_name text, type_lines text[], description text, model text,
      unit text, specs text[], cost numeric, cost_currency char(3), qty numeric, qty_follows_links boolean,
      profit_pct numeric, discount_pct numeric, default_profit_zero boolean, sort_order integer`;
    const updates = records.filter((r) => !r.isNew);
    const inserts = records.filter((r) => r.isNew);

    if (updates.length) {
      // IS DISTINCT FROM: untouched lines are not rewritten (keeps the audit log quiet).
      await db.query(`
        UPDATE boq_items bi SET line = r.line, brand_id = r.brand_id, product_id = r.product_id, price_list_id = r.price_list_id,
          is_custom = r.is_custom, is_edited = r.is_edited, group_name = r.group_name, group_lines = r.group_lines,
          type_name = r.type_name, type_lines = r.type_lines, description = r.description, model = r.model, unit = r.unit,
          specs = r.specs, cost = r.cost, cost_currency = r.cost_currency, qty = r.qty, qty_follows_links = r.qty_follows_links,
          profit_pct = r.profit_pct, discount_pct = r.discount_pct, default_profit_zero = r.default_profit_zero, sort_order = r.sort_order
        FROM jsonb_to_recordset($2::jsonb) AS r(${cols})
        WHERE bi.id = r.id AND bi.boq_id = $1
          AND (bi.line, bi.is_edited, bi.group_name, bi.group_lines, bi.type_name, bi.type_lines, bi.description, bi.model, bi.unit,
               bi.specs, bi.cost, bi.qty, bi.qty_follows_links, bi.profit_pct, bi.discount_pct, bi.sort_order)
          IS DISTINCT FROM
              (r.line, r.is_edited, r.group_name, r.group_lines, r.type_name, r.type_lines, r.description, r.model, r.unit,
               r.specs, r.cost, r.qty, r.qty_follows_links, r.profit_pct, r.discount_pct, r.sort_order)`,
        [boqId, JSON.stringify(updates)]);
    }
    if (inserts.length) {
      await db.query(`
        INSERT INTO boq_items (id, boq_id, line, brand_id, product_id, price_list_id, is_custom, is_edited, group_name, group_lines,
          type_name, type_lines, description, model, unit, specs, cost, cost_currency, qty, qty_follows_links, profit_pct,
          discount_pct, default_profit_zero, sort_order)
        SELECT r.id, $1, r.line, r.brand_id, r.product_id, r.price_list_id, r.is_custom, r.is_edited, r.group_name, r.group_lines,
          r.type_name, r.type_lines, r.description, r.model, r.unit, r.specs, r.cost, r.cost_currency, r.qty, r.qty_follows_links,
          r.profit_pct, r.discount_pct, r.default_profit_zero, r.sort_order
        FROM jsonb_to_recordset($2::jsonb) AS r(${cols})`,
        [boqId, JSON.stringify(inserts)]);
    }

    await db.query('SELECT refresh_boq_totals($1)', [boqId]);
    const after = await db.query('SELECT xmin::text AS version, updated_at FROM boqs WHERE id = $1', [boqId]);
    return { version: after.rows[0].version as string, keys, savedAt: after.rows[0].updated_at.toISOString() as string };
  });
}

// ---------------------------------------------------------------------
// Create BOQ / revision
// ---------------------------------------------------------------------
export async function createRevision(u: SessionUser, boqId: string): Promise<string> {
  const b = await getVisibleBoq(u, boqId);
  const perms = editorPermissions(u, b);
  if (!perms.canRevise) {
    throw new ApiError(403, b.status === 'draft' ? 'This BOQ is still a draft; edit it directly.' : 'Only the latest revision can be revised.');
  }
  return tx(u.id, async (db) => {
    const { rows } = await db.query('SELECT create_boq_revision($1) AS id', [boqId]);
    return rows[0].id as string;
  });
}

export async function companyDefaults() {
  const { rows } = await query(`SELECT * FROM company_settings WHERE id = 1`);
  return rows[0];
}
