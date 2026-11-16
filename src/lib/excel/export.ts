import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { ApiError } from '@/lib/api';
import { can, type SessionUser } from '@/lib/auth/session';
import { calculate } from '@/lib/calc';
import { getVisibleBoq, loadBoqForServer } from '@/lib/boq/repo';
import { toCalcRow, toCalcSettings } from '@/lib/boq/rows';
import type { ExportChoice, OfferCurrency } from '@/lib/boq/types';
import { tx, type Db } from '@/lib/db';
import { assertClientSafe, buildWorkbook, exportFileName } from './build';

// turbopackIgnore: the folder is chosen at runtime and must not pull the project into the server bundle.
const storageRoot = () => path.resolve(/*turbopackIgnore: true*/ process.env.STORAGE_DIR || './storage');
const UUID = /^[0-9a-f-]{36}$/;

/** Private file path; ids are uuids we generated, so no user input reaches the path. */
export function filePath(boqId: string, exportId: string) {
  if (!UUID.test(boqId) || !UUID.test(exportId)) throw new Error('bad id');
  return path.join(storageRoot(), 'exports', boqId, `${exportId}.xlsx`);
}

/** Name shown to the client: no path characters, always .xlsx, never empty. */
function uploadedFileName(raw: string) {
  const base = raw.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\.xlsx$/i, '').trim().slice(0, 80);
  return `${base || 'BOQ'}.xlsx`;
}

export interface ExportResult { id: string; fileName: string; currency: OfferCurrency; withCosting: boolean }

export interface BuiltFile { id: string; buf: Buffer; fileName: string; currency: OfferCurrency }
export interface BuiltExports { files: BuiltFile[]; snapshot: Record<string, unknown>; zeroRateLines: string[] }

/**
 * Builds the workbook(s) in memory from the SAVED state of the BOQ. No database row and no file is written here:
 * the caller persists them, so a send can put the files and the queue row in one transaction.
 * forClient = true (used by Send) never includes costing and re-checks the file.
 */
export async function buildExports(
  u: SessionUser, boqId: string, choice: ExportChoice, opts: { withCosting: boolean; forClient?: boolean },
): Promise<BuiltExports> {
  if (!can(u, 'boq.export')) throw new ApiError(403, 'You do not have permission to export BOQs.');
  if (opts.withCosting && (opts.forClient || !can(u, 'boq.costing.view'))) throw new ApiError(403, 'Costing export is not allowed here.');
  await getVisibleBoq(u, boqId);

  const data = await loadBoqForServer(boqId);
  const brand = data.brands.find((b) => b.id === data.settings.selectedBrandId);
  const calc = calculate(data.rows.map(toCalcRow), toCalcSettings(data.settings));
  const inOffer = data.rows.filter((r) => calc.items.get(r.key)!.countsInOffer && calc.items.get(r.key)!.qty.gt(0));
  if (!inOffer.length) throw new ApiError(400, 'Add a quantity to at least one item first.');
  const zeroRate = inOffer.filter((r) => calc.items.get(r.key)!.rate.isZero());

  const currencies: OfferCurrency[] = choice === 'BOTH' ? ['USD', 'BDT'] : [choice];
  const files: BuiltFile[] = [];
  for (const currency of currencies) {
    const wb = await buildWorkbook({ ...data, currency, withCosting: opts.withCosting });
    if (opts.forClient || !opts.withCosting) assertClientSafe(wb);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    files.push({ id: randomUUID(), buf, fileName: exportFileName(data.header, brand?.name, currency, opts.withCosting), currency });
  }

  const T = calc.totals;
  const snapshot = {
    revision: data.header.revision, brand: brand?.code, exchangeRate: data.settings.exchangeRate,
    aBdt: T.aBdt.toFixed(2), aUsd: T.aUsd.toFixed(2), bBdt: T.bBdt.toFixed(2), cBdt: T.cBdt.toFixed(2),
    grandTotalBdt: T.grandTotalBdt.toFixed(2), usdOfferTakaTotal: T.usdOfferTakaTotal.toFixed(2),
    zeroRateLines: zeroRate.length,
  };
  return { files, snapshot, zeroRateLines: zeroRate.map((r) => r.model || r.description).slice(0, 20) };
}

/** Where the built files will be placed (used to clean up when a transaction rolls back). */
export const exportPaths = (boqId: string, files: BuiltFile[]) => files.map((f) => filePath(boqId, f.id));

/** Writes the built files and records them in boq_exports + audit_log inside the caller's transaction. */
export async function persistExports(
  u: SessionUser, db: Db, boqId: string, built: BuiltExports, withCosting: boolean,
): Promise<ExportResult[]> {
  const firstFile = built.files[0];
  if (firstFile) await mkdir(path.dirname(filePath(boqId, firstFile.id)), { recursive: true });
  for (const f of built.files) await writeFile(filePath(boqId, f.id), f.buf, { flag: 'wx' });

  const results: ExportResult[] = [];
  for (const f of built.files) {
    await db.query(
      `INSERT INTO boq_exports (id, boq_id, currency, with_costing, file_name, file_url, totals_snapshot, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [f.id, boqId, f.currency, withCosting, f.fileName, `exports/${boqId}/${f.id}.xlsx`, built.snapshot, u.id]);
    await db.query(`INSERT INTO audit_log (user_id, action, entity, entity_id, new_data) VALUES ($1, 'EXPORT', 'boqs', $2, $3)`,
      [u.id, boqId, { exportId: f.id, currency: f.currency, withCosting }]);
    results.push({ id: f.id, fileName: f.fileName, currency: f.currency, withCosting });
  }
  return results;
}

/** Builds, stores and logs the export(s) (download path). Opens its own transaction. */
export async function createExports(u: SessionUser, boqId: string, choice: ExportChoice, opts: { withCosting: boolean; forClient?: boolean }) {
  const built = await buildExports(u, boqId, choice, opts);
  try {
    const results = await tx(u.id, (db) => persistExports(u, db, boqId, built, opts.withCosting));
    return { files: results, zeroRateLines: built.zeroRateLines };
  } catch (e) {
    await Promise.all(exportPaths(boqId, built.files).map((p) => rm(p, { force: true }).catch(() => {})));
    throw e;
  }
}

/**
 * Stores the workbook the estimator edited in Excel, inside the caller's transaction (Send puts this in the same
 * transaction as the BOQ lock and the queue row). Same checks as an export: a valid .xlsx without the costing sheet.
 */
export async function storeUploadedExport(
  db: Db, u: SessionUser, boqId: string, file: { buf: Buffer; fileName: string }, currency: OfferCurrency,
): Promise<ExportResult> {
  if (!can(u, 'boq.export')) throw new ApiError(403, 'You do not have permission to export BOQs.');
  await getVisibleBoq(u, boqId);

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(file.buf as unknown as ArrayBuffer);
  } catch {
    throw new ApiError(400, 'That is not a valid Excel (.xlsx) file. Open it in Excel, choose Save As → Excel Workbook (.xlsx), then upload it again.');
  }
  try {
    assertClientSafe(wb);
  } catch (e) {
    throw new ApiError(400, (e as Error).message);
  }

  const id = randomUUID();
  const fileName = uploadedFileName(file.fileName);
  await mkdir(path.dirname(filePath(boqId, id)), { recursive: true });
  await writeFile(filePath(boqId, id), file.buf, { flag: 'wx' });

  const sha256 = createHash('sha256').update(file.buf).digest('hex');
  await db.query(
    `INSERT INTO boq_exports (id, boq_id, currency, with_costing, file_name, file_url, totals_snapshot, created_by, source, original_name, sha256)
     VALUES ($1, $2, $3, false, $4, $5, $6, $7, 'manual', $8, $9)`,
    [id, boqId, currency, fileName, `exports/${boqId}/${id}.xlsx`, { manual: true, originalName: file.fileName, sha256 }, u.id, file.fileName, sha256]);
  await db.query(`INSERT INTO audit_log (user_id, action, entity, entity_id, new_data) VALUES ($1, 'EXPORT', 'boqs', $2, $3)`,
    [u.id, boqId, { exportId: id, manual: true, fileName, sha256 }]);
  return { id, fileName, currency, withCosting: false };
}

/** Reads a stored export after checking the user may see its BOQ (and costing, if the file has it). */
export async function readExport(u: SessionUser, exportId: string) {
  if (!UUID.test(exportId)) throw new ApiError(404, 'File not found.');
  const { query } = await import('@/lib/db');
  const { rows } = await query('SELECT id, boq_id, file_name, with_costing FROM boq_exports WHERE id = $1', [exportId]);
  const e = rows[0];
  if (!e) throw new ApiError(404, 'File not found.');
  await getVisibleBoq(u, e.boq_id);
  if (e.with_costing && !can(u, 'boq.costing.view')) throw new ApiError(404, 'File not found.');
  const buf = await readFile(filePath(e.boq_id, e.id)).catch(() => { throw new ApiError(410, 'The file is no longer stored. Export again.'); });
  return { buf, fileName: e.file_name as string };
}
