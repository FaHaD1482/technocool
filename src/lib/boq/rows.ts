/** Row helpers shared by the editor (client) and the server (save, export). No DOM, no database. */
import { dec, isBlank, type CalcRow, type CalcSettings, type Dec } from '@/lib/calc';
import type { BoqRow, BoqSettings, CatalogEntry } from './types';

export const catalogKey = (productId: string) => `p:${productId}`;

export function rowFromCatalog(c: CatalogEntry): BoqRow {
  return {
    key: catalogKey(c.productId),
    itemId: null,
    productId: c.productId,
    priceListId: c.priceListId,
    line: c.kind === 'imported' ? 'A' : 'B',
    brandId: c.brandId,
    isCustom: false,
    isEdited: false,
    groupName: c.groupName,
    groupLines: c.groupLines,
    typeName: c.typeName,
    typeLines: c.typeLines,
    description: c.description,
    model: c.model,
    unit: c.unit,
    specs: c.specs,
    cost: c.cost,
    qty: '0',
    qtyFollowsLinks: c.linkSources.length > 0,
    linkSources: c.linkSources,
    profitPct: null,          // null = BOQ default (0% for freight lines, via defaultProfitZero)
    discountPct: null,
    defaultProfitZero: c.defaultProfitZero,
    sortOrder: c.sortOrder,
  };
}

/** Saved lines first in their place, then every catalogue product not yet in the BOQ (qty 0). */
export function mergeWithCatalog(saved: BoqRow[], catalog: CatalogEntry[]): BoqRow[] {
  const used = new Set(saved.map((r) => r.productId).filter(Boolean));
  const virtual = catalog.filter((c) => !used.has(c.productId)).map(rowFromCatalog);
  return sortRows([...saved, ...virtual]);
}

const lineOrder = { A: 0, B: 1, C: 1 } as const;
export function sortRows(rows: BoqRow[]): BoqRow[] {
  return [...rows].sort((a, b) =>
    lineOrder[a.line] - lineOrder[b.line] ||
    (a.brandId ?? 0) - (b.brandId ?? 0) ||
    Number(a.isCustom) - Number(b.isCustom) ||
    a.sortOrder - b.sortOrder);
}

export function toCalcSettings(s: BoqSettings): CalcSettings {
  return {
    selectedBrandId: s.selectedBrandId, exchangeRate: s.exchangeRate,
    impProfitPct: s.impProfitPct, impDiscountPct: s.impDiscountPct,
    locProfitPct: s.locProfitPct, locDiscountPct: s.locDiscountPct,
    aitPct: s.aitPct, vatPct: s.vatPct, taxMethod: s.taxMethod,
    taxBaseA: s.taxBaseA, taxBaseB: s.taxBaseB, taxBaseC: s.taxBaseC, addTaxToTotal: s.addTaxToTotal,
  };
}

export const toCalcRow = (r: BoqRow): CalcRow => ({
  key: r.key, line: r.line, brandId: r.brandId, productId: r.productId, cost: r.cost, qty: r.qty,
  qtyFollowsLinks: r.qtyFollowsLinks, linkSources: r.linkSources, profitPct: r.profitPct, discountPct: r.discountPct,
  defaultProfitZero: r.defaultProfitZero,
});

/** A line is stored in boq_items when it has a quantity, was added by hand, or carries its own changes. */
export function shouldPersist(r: BoqRow, effQty: Dec): boolean {
  if (r.isCustom || r.isEdited) return true;
  if (dec(r.qty).gt(0) || effQty.gt(0)) return true;
  const ownProfit = !isBlank(r.profitPct) && !(r.defaultProfitZero && dec(r.profitPct).isZero());
  return ownProfit || !isBlank(r.discountPct);
}

/** Did the user change the copied product fields (not qty / % / line)? */
export function differsFromCatalog(r: BoqRow, c: CatalogEntry | undefined): boolean {
  if (!c) return false;
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const costEq = (isBlank(r.cost) && isBlank(c.cost)) || (!isBlank(r.cost) && !isBlank(c.cost) && dec(r.cost).eq(dec(c.cost)));
  return r.description !== c.description || (r.model ?? '') !== (c.model ?? '') || r.unit !== c.unit ||
    r.groupName !== c.groupName || (r.typeName ?? '') !== (c.typeName ?? '') || !same(r.specs, c.specs) || !costEq;
}

export interface Grouped<T> { group: string; groupLines: string[]; types: { type: string | null; typeLines: string[]; rows: T[] }[] }

/** Group rows by group, then type, in order of first appearance (stable for the screen and the Excel file). */
export function groupRows<T extends Pick<BoqRow, 'groupName' | 'groupLines' | 'typeName' | 'typeLines'>>(rows: T[]): Grouped<T>[] {
  const out: Grouped<T>[] = [];
  const gIdx = new Map<string, Grouped<T>>();
  for (const r of rows) {
    let g = gIdx.get(r.groupName);
    if (!g) { g = { group: r.groupName, groupLines: r.groupLines, types: [] }; gIdx.set(r.groupName, g); out.push(g); }
    const tName = r.typeName || null;
    let t = g.types.find((x) => x.type === tName);
    if (!t) { t = { type: tName, typeLines: r.typeLines, rows: [] }; g.types.push(t); }
    t.rows.push(r);
  }
  return out;
}

export const textMatch = (r: BoqRow, q: string) =>
  !q || [r.groupName, r.typeName ?? '', r.description, r.model ?? '', ...r.specs, ...r.groupLines].join(' ').toLowerCase().includes(q);
