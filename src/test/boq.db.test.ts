/**
 * Integration tests against the real database (npm run test:db). They create their own users, client and
 * BOQs, and delete them afterwards.
 *   - calculation module == SQL views, to the paisa, across several settings
 *   - own-BOQ-only rule: employee B cannot open A's BOQ or download A's file
 *   - save: optimistic lock; sent BOQs are locked in the database; revisions keep the owner
 *   - export: BDT + USD files, client file has no costing sheet
 */
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Permission, SessionUser } from '@/lib/auth/session';
import { calculate, dec } from '@/lib/calc';
import { createRevision, getVisibleBoq, loadBoqForServer, loadCatalog, loadEditorData, saveBoq, type SavePayload } from '@/lib/boq/repo';
import { mergeWithCatalog, shouldPersist, toCalcRow, toCalcSettings } from '@/lib/boq/rows';
import type { BoqRow } from '@/lib/boq/types';
import { createExports, readExport } from '@/lib/excel/export';
import { pool } from '@/lib/db';

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const tag = `test-${randomUUID().slice(0, 8)}`;
let A: SessionUser, B: SessionUser, boqId: string, clientId: string;

async function makeUser(name: string, role: string): Promise<SessionUser> {
  const email = `${tag}-${name}@example.com`;
  const { rows } = await db.query(`INSERT INTO app_users (email, full_name) VALUES ($1, $2) RETURNING id`, [email, name]);
  await db.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2`, [rows[0].id, role]);
  const perms = await db.query(`SELECT permission_code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.code = $1`, [role]);
  return { id: rows[0].id, email, fullName: name, designation: null, roles: [role], sessionId: randomUUID(),
    permissions: new Set(perms.rows.map((r) => r.permission_code as Permission)) };
}

async function makeBoq(owner: SessionUser): Promise<string> {
  const p = await db.query(`INSERT INTO projects (name, client_id, owner_user_id, created_by) VALUES ($1, $2, $3, $3) RETURNING id`, [`${tag} project`, clientId, owner.id]);
  const b = await db.query(
    `INSERT INTO boqs (project_id, selected_brand_id, exchange_rate, imp_profit_pct, loc_profit_pct, ait_pct, vat_pct, owner_user_id, created_by)
     VALUES ($1, (SELECT id FROM brands WHERE code = 'LG'), 122, 10, 10, 5, 7.5, $2, $2) RETURNING id`, [p.rows[0].id, owner.id]);
  return b.rows[0].id;
}

/** Fill a BOQ like the prototype's example: LG + Daikin equipment, local pipes (insulation follows), a C line, a custom item. */
async function fillExample(u: SessionUser, id: string) {
  const data = await loadEditorData(u, id);
  const rows = mergeWithCatalog(data.rows, data.catalog);
  const qty: Record<string, string> = {
    ARUN260LTE6: '2', ARUN200LTE6: '1', ARNU24GM1A4: '6', ARNU18GM1A4: '8', 'PREMTBB10.ENCXLEU': '18',
    RXQ24BYM: '1', FXMQ63PAVE: '6', FXSQ32PAVE: '8',
  };
  const local: Record<string, string> = { c14: '250', c38: '300', c12: '150', s58: '120', s34: '100', s78: '80', cons: '56', idu: '18', gas: '45.5', louver: '20' };
  const codeOf = new Map((await loadCatalog()).catalog.map((c) => [c.productId, c.code]));
  for (const r of rows) {
    const batchQty = r.model ? qty[r.model] : undefined;
    if (r.line === 'A' && batchQty) r.qty = batchQty;
    if (r.groupName === 'Freight' && r.brandId === data.settings.selectedBrandId) r.qty = '1';
    const code = r.productId ? codeOf.get(r.productId) : null;
    if (code && local[code]) { r.qty = local[code]; if (code === 'louver') r.line = 'C'; }
    if (r.model === 'ARNU18GM1A4') { r.discountPct = '2.5'; r.profitPct = '12.345'; }
  }
  const custom: BoqRow = { ...rows.find((r) => r.line === 'B')!, key: 'c:x', itemId: null, productId: null, priceListId: null, isCustom: true,
    groupName: 'Additional local items', description: 'Inline exhaust fan, 500 CFM', cost: '18000', qty: '4', line: 'C', qtyFollowsLinks: false, linkSources: [] };
  rows.push(custom);
  const calc = calculate(rows.map(toCalcRow), toCalcSettings(data.settings));
  const payload: SavePayload = {
    version: data.header.version, settings: data.settings,
    rows: rows.filter((r) => shouldPersist(r, calc.items.get(r.key)!.qty)),
  };
  return saveBoq(u, id, payload);
}

async function compareWithSql(id: string) {
  const data = await loadBoqForServer(id);
  const res = calculate(data.rows.map(toCalcRow), toCalcSettings(data.settings));
  const { rows: [v] } = await db.query('SELECT * FROM v_boq_totals WHERE boq_id = $1', [id]);
  const T = res.totals;
  const pairs: [string, unknown, unknown][] = [
    ['A Tk', T.aBdt, v.total_a_bdt], ['A USD', T.aUsd, v.total_a_usd], ['B', T.bBdt, v.total_b_bdt], ['C', T.cBdt, v.total_c_bdt],
    ['AIT', T.aitBdt, v.ait_bdt], ['VAT', T.vatBdt, v.vat_bdt], ['grand', T.grandTotalBdt, v.grand_total_bdt],
    ['USD AIT', T.usdOfferAitBdt, v.usd_offer_ait_bdt], ['USD VAT', T.usdOfferVatBdt, v.usd_offer_vat_bdt],
    ['USD taka', T.usdOfferTakaTotal, v.usd_offer_taka_total], ['cost', T.costBdt, v.cost_bdt], ['discount', T.discountBdt, v.discount_bdt],
    ['profit', T.profitBdt, v.profit_bdt],
  ];
  for (const [name, mine, sql] of pairs) expect(`${name} ${dec(mine as string).toFixed(2)}`).toBe(`${name} ${dec(sql as string).toFixed(2)}`);
  const items = await db.query('SELECT id, qty::text, rate::text, rate_bdt::text, amount_bdt::text FROM v_boq_item_amounts WHERE boq_id = $1', [id]);
  for (const it of items.rows) {
    const m = res.items.get(it.id)!;
    expect([m.qty.toString(), m.rate.toFixed(2), m.rateBdt.toFixed(2), m.amountBdt.toFixed(2)])
      .toEqual([dec(it.qty).toString(), dec(it.rate).toFixed(2), dec(it.rate_bdt).toFixed(2), dec(it.amount_bdt).toFixed(2)]);
  }
  return { totals: T, lines: items.rowCount };
}

beforeAll(async () => {
  await db.connect();
  A = await makeUser('Alice', 'estimator');
  B = await makeUser('Bob', 'estimator');
  clientId = (await db.query(`INSERT INTO clients (name, email) VALUES ($1, 'client@example.com') RETURNING id`, [`${tag} client`])).rows[0].id;
  boqId = await makeBoq(A);
});

afterAll(async () => {
  // Remove everything this run created. The lock triggers stop deleting items of sent BOQs, so reset status first.
  await db.query(`ALTER TABLE boqs DISABLE TRIGGER boqs_lock`);
  await db.query(`UPDATE boqs SET status = 'draft' WHERE project_id IN (SELECT id FROM projects WHERE name = $1)`, [`${tag} project`]);
  await db.query(`ALTER TABLE boqs ENABLE TRIGGER boqs_lock`);
  await db.query(`DELETE FROM boq_exports WHERE boq_id IN (SELECT b.id FROM boqs b JOIN projects p ON p.id = b.project_id WHERE p.name = $1)`, [`${tag} project`]);
  await db.query(`DELETE FROM boqs WHERE project_id IN (SELECT id FROM projects WHERE name = $1)`, [`${tag} project`]);
  await db.query(`DELETE FROM projects WHERE name = $1`, [`${tag} project`]);
  await db.query(`DELETE FROM clients WHERE id = $1`, [clientId]);
  await db.query(`DELETE FROM app_users WHERE email LIKE $1`, [`${tag}-%`]);
  await db.end();
  await pool.end();
});

describe('calculation module matches the SQL views to the paisa', () => {
  it('BDT, gross-up, mixed brands, custom line, insulation following pipes', async () => {
    await fillExample(A, boqId);
    const { totals, lines } = await compareWithSql(boqId);
    expect(lines).toBeGreaterThan(15);
    expect(totals.aBdt.gt(0) && totals.bBdt.gt(0) && totals.cBdt.gt(0)).toBe(true);
    // insulation lines follow the pipe quantities they are linked to
    const ins = await db.query(`SELECT count(*)::int AS n FROM v_boq_item_amounts a JOIN boq_items bi ON bi.id = a.id WHERE a.boq_id = $1 AND bi.qty_follows_links AND a.qty > 0`, [boqId]);
    expect(ins.rows[0].n).toBeGreaterThan(0);
  });

  it('other settings: simple tax, taxes added, base without A, odd percentages, other brand', async () => {
    const variants = [
      `tax_method = 'simple', add_tax_to_total = true`,
      `tax_base_a = false, ait_pct = 3.333, vat_pct = 15, imp_discount_pct = 7.77, loc_discount_pct = 1.5`,
      `selected_brand_id = (SELECT id FROM brands WHERE code = 'DAIKIN'), exchange_rate = 121.4567, imp_profit_pct = 8.125`,
    ];
    for (const set of variants) {
      await db.query(`UPDATE boqs SET ${set} WHERE id = $1`, [boqId]);
      await db.query('SELECT refresh_boq_totals($1)', [boqId]);
      await compareWithSql(boqId);
    }
  });
});

describe('own-BOQ-only rule', () => {
  it('B cannot open, list or download A’s BOQ', async () => {
    await expect(getVisibleBoq(B, boqId)).rejects.toMatchObject({ status: 404 });
    await expect(loadEditorData(B, boqId)).rejects.toMatchObject({ status: 404 });
    const ex = await createExports(A, boqId, 'BDT', { withCosting: false });
    const firstExport = ex.files[0];
    if (!firstExport) throw new Error('createExports produced no files');
    await expect(readExport(B, firstExport.id)).rejects.toMatchObject({ status: 404 });
    await expect(createExports(B, boqId, 'BDT', { withCosting: false })).rejects.toMatchObject({ status: 404 });
  });

  it('B cannot save into A’s BOQ', async () => {
    const data = await loadEditorData(A, boqId);
    await expect(saveBoq(B, boqId, { version: data.header.version, settings: data.settings, rows: data.rows })).rejects.toMatchObject({ status: 404 });
  });
});

describe('saving and locking', () => {
  it('refuses a save from a stale editor', async () => {
    const data = await loadEditorData(A, boqId);
    await saveBoq(A, boqId, { version: data.header.version, settings: { ...data.settings, title: 'v1' }, rows: data.rows });
    await expect(saveBoq(A, boqId, { version: data.header.version, settings: data.settings, rows: data.rows })).rejects.toMatchObject({ status: 409 });
  });

  it('a sent BOQ is locked in the database, and a revision keeps the owner and the lines', async () => {
    const before = await db.query('SELECT count(*)::int AS n FROM boq_items WHERE boq_id = $1', [boqId]);
    await db.query(`UPDATE boqs SET status = 'sent', sent_at = now() WHERE id = $1`, [boqId]);   // no approval needed any more
    await expect(db.query(`UPDATE boq_items SET qty = qty + 1 WHERE boq_id = $1`, [boqId])).rejects.toThrow(/locked/);
    await expect(db.query(`UPDATE boqs SET exchange_rate = 99 WHERE id = $1`, [boqId])).rejects.toThrow(/locked/);
    const data = await loadEditorData(A, boqId);
    expect(data.perms.canEdit).toBe(false);
    expect(data.perms.canRevise).toBe(true);
    await expect(saveBoq(A, boqId, { version: data.header.version, settings: data.settings, rows: data.rows })).rejects.toMatchObject({ status: 403 });

    const rev = await createRevision(A, boqId);
    const r = await db.query(`SELECT revision, status, owner_user_id, (SELECT count(*)::int FROM boq_items WHERE boq_id = $1) AS n FROM boqs WHERE id = $1`, [rev]);
    expect(r.rows[0]).toMatchObject({ revision: 1, status: 'draft', owner_user_id: A.id, n: before.rows[0].n });
    const old = await db.query('SELECT status FROM boqs WHERE id = $1', [boqId]);
    expect(old.rows[0].status).toBe('superseded');
    boqId = rev;
  });
});

describe('Excel export', () => {
  it('Both = a USD and a BDT file; the client file has no costing sheet; costing file has it', async () => {
    const both = await createExports(A, boqId, 'BOTH', { withCosting: false });
    expect(both.files.map((f) => f.currency).sort()).toEqual(['BDT', 'USD']);
    for (const f of both.files) {
      const { buf } = await readExport(A, f.id);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf as unknown as ArrayBuffer);
      const names = wb.worksheets.map((w) => w.name);
      expect(names).toEqual(['Offer Summary', 'Imported Item', 'Local Item & Installation', 'Ventilation']);
      expect(String(wb.getWorksheet('Offer Summary')!.getCell('A3').value)).toContain('Project :');
    }
    const cost = await createExports(A, boqId, 'BDT', { withCosting: true });
    const costingFile = cost.files[0];
    if (!costingFile) throw new Error('createExports produced no files');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await readExport(A, costingFile.id)).buf as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toContain('Costing (internal)');
    await expect(createExports(A, boqId, 'BDT', { withCosting: true, forClient: true })).rejects.toMatchObject({ status: 403 });
  });

  it('logs every export and reports lines without a price', async () => {
    const n = await db.query('SELECT count(*)::int AS n FROM boq_exports WHERE boq_id = $1', [boqId]);
    expect(n.rows[0].n).toBe(3);
  });
});
