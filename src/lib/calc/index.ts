/**
 * The one BOQ calculation module. The screen, the Excel file and the API all use it, and
 * src/lib/calc/calc.db.test.ts checks it against the SQL views (v_boq_item_amounts, v_boq_totals) to the paisa.
 *
 *   Rate      = round( round(cost × (1 + profit%), 2) × (1 − discount%), 2 )
 *   Line A    Rate Tk = round(Rate USD × exchange rate, 2); Amount Tk = Rate Tk × Qty
 *   AIT/VAT   gross-up: AIT = base × a ÷ (100 − a); VAT = (base + AIT) × v ÷ (100 − v)
 *             simple:   AIT = base × a ÷ 100;      VAT = (base + AIT) × v ÷ 100
 *   USD offer: line A is on the client's L.C, so AIT and VAT use lines B and C only.
 *
 * Decimal arithmetic (never floats) with ROUND_HALF_UP, which equals PostgreSQL round(numeric) for the
 * non-negative values used here.
 */
import DecimalBase from 'decimal.js';

export const Dec = DecimalBase.clone({ precision: 60, rounding: DecimalBase.ROUND_HALF_UP });
export type Dec = InstanceType<typeof Dec>;

export type Line = 'A' | 'B' | 'C';
export type Num = string | number | null | undefined;
export type TaxMethod = 'gross' | 'simple';

const ZERO = new Dec(0);
const HUNDRED = new Dec(100);

/** Parse user/DB input. Blank, null or junk is 0 (same as the prototype's num()). Commas are ignored. */
export function dec(v: Num): Dec {
  if (v === null || v === undefined || v === '') return ZERO;
  try {
    const d = new Dec(typeof v === 'string' ? v.replace(/,/g, '').trim() || '0' : v);
    return d.isFinite() ? d : ZERO;
  } catch {
    return ZERO;
  }
}
export const isBlank = (v: Num) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
export const r2 = (d: Dec) => d.toDecimalPlaces(2, Dec.ROUND_HALF_UP);

export interface CalcSettings {
  selectedBrandId: number;
  exchangeRate: Num;
  impProfitPct: Num;
  impDiscountPct: Num;
  locProfitPct: Num;
  locDiscountPct: Num;
  aitPct: Num;
  vatPct: Num;
  taxMethod: TaxMethod;
  taxBaseA: boolean;
  taxBaseB: boolean;
  taxBaseC: boolean;
  addTaxToTotal: boolean;
}

export interface CalcRow {
  key: string;
  line: Line;
  brandId: number | null;
  productId: string | null;
  cost: Num;                 // USD for line A, Tk for B and C; blank = no price
  qty: Num;
  qtyFollowsLinks: boolean;  // quantity = sum of the linked pipe lines in this BOQ
  linkSources?: string[];    // product ids this line follows
  profitPct: Num;            // blank = BOQ default
  discountPct: Num;          // blank = BOQ default
  defaultProfitZero: boolean;
}

export interface ItemAmount {
  qty: Dec;
  profitPct: Dec;
  discountPct: Dec;
  missingPrice: boolean;
  listRate: Dec;      // before discount (USD for A, Tk for B/C)
  rate: Dec;          // selling rate (USD for A, Tk for B/C)
  rateBdt: Dec;
  amountUsd: Dec | null;
  amountBdt: Dec;
  costBdt: Dec;
  discountBdt: Dec;
  countsInOffer: boolean;
}

export interface Totals {
  aBdt: Dec; aUsd: Dec; bBdt: Dec; cBdt: Dec;
  costBdt: Dec; discountBdt: Dec;
  baseBdt: Dec; aitBdt: Dec; vatBdt: Dec; grandTotalBdt: Dec;
  // USD offer: A stays in USD; the Taka part is B + C (+ taxes on B and C if added)
  usdOfferBase: Dec; usdOfferAitBdt: Dec; usdOfferVatBdt: Dec; usdOfferTakaTotal: Dec;
  profitBdt: Dec;
}

export interface BrandTotal { items: number; importedBdt: Dec; importedUsd: Dec }

export interface CalcResult {
  items: Map<string, ItemAmount>;
  totals: Totals;
  brandTotals: Map<number, BrandTotal>;
}

export function effectivePcts(row: CalcRow, s: CalcSettings) {
  const profit = !isBlank(row.profitPct) ? dec(row.profitPct)
    : row.defaultProfitZero ? ZERO
    : dec(row.line === 'A' ? s.impProfitPct : s.locProfitPct);
  const discount = !isBlank(row.discountPct) ? dec(row.discountPct)
    : dec(row.line === 'A' ? s.impDiscountPct : s.locDiscountPct);
  return { profit, discount };
}

export function taxes(base: Dec, aitPct: Num, vatPct: Num, method: TaxMethod) {
  const a = dec(aitPct), v = dec(vatPct);
  if (method === 'gross') {
    const ait = a.lt(HUNDRED) ? base.mul(a).div(HUNDRED.minus(a)) : ZERO;
    const vat = v.lt(HUNDRED) ? base.plus(ait).mul(v).div(HUNDRED.minus(v)) : ZERO;
    return { ait, vat };
  }
  const ait = base.mul(a).div(HUNDRED);
  return { ait, vat: base.plus(ait).mul(v).div(HUNDRED) };
}

/** Effective quantity of each row; insulation that follows pipe sizes sums the linked rows' raw qty (as the SQL view does). */
export function effectiveQtys(rows: CalcRow[]): Map<string, Dec> {
  const qtyByProduct = new Map<string, Dec>();
  for (const r of rows) if (r.productId) qtyByProduct.set(r.productId, (qtyByProduct.get(r.productId) ?? ZERO).plus(dec(r.qty)));
  const out = new Map<string, Dec>();
  for (const r of rows) {
    if (r.qtyFollowsLinks) {
      out.set(r.key, (r.linkSources ?? []).reduce((acc, id) => acc.plus(qtyByProduct.get(id) ?? ZERO), ZERO));
    } else {
      out.set(r.key, dec(r.qty));
    }
  }
  return out;
}

export function calcItem(row: CalcRow, s: CalcSettings, qty: Dec): ItemAmount {
  const { profit, discount } = effectivePcts(row, s);
  const cost = dec(row.cost);
  const listRate = r2(cost.mul(HUNDRED.plus(profit)).div(HUNDRED));
  const rate = r2(listRate.mul(HUNDRED.minus(discount)).div(HUNDRED));
  const fx = dec(s.exchangeRate);
  const isA = row.line === 'A';
  const rateBdt = isA ? r2(rate.mul(fx)) : rate;
  return {
    qty,
    profitPct: profit,
    discountPct: discount,
    missingPrice: isBlank(row.cost),
    listRate,
    rate,
    rateBdt,
    amountUsd: isA ? rate.mul(qty) : null,
    amountBdt: rateBdt.mul(qty),
    costBdt: isA ? cost.mul(qty).mul(fx) : cost.mul(qty),
    discountBdt: isA ? listRate.minus(rate).mul(qty).mul(fx) : listRate.minus(rate).mul(qty),
    countsInOffer: !isA || row.brandId === s.selectedBrandId,
  };
}

export function calculate(rows: CalcRow[], s: CalcSettings): CalcResult {
  const qtys = effectiveQtys(rows);
  const items = new Map<string, ItemAmount>();
  const brandTotals = new Map<number, BrandTotal>();
  let aBdt = ZERO, aUsd = ZERO, bBdt = ZERO, cBdt = ZERO, costBdt = ZERO, discountBdt = ZERO;

  for (const r of rows) {
    const it = calcItem(r, s, qtys.get(r.key) ?? ZERO);
    items.set(r.key, it);
    if (r.line === 'A' && r.brandId !== null) {
      const bt = brandTotals.get(r.brandId) ?? { items: 0, importedBdt: ZERO, importedUsd: ZERO };
      bt.importedBdt = bt.importedBdt.plus(it.amountBdt);
      bt.importedUsd = bt.importedUsd.plus(it.amountUsd ?? ZERO);
      if (it.qty.gt(0)) bt.items++;
      brandTotals.set(r.brandId, bt);
    }
    if (!it.countsInOffer) continue;
    if (r.line === 'A') { aBdt = aBdt.plus(it.amountBdt); aUsd = aUsd.plus(it.amountUsd ?? ZERO); }
    else if (r.line === 'B') bBdt = bBdt.plus(it.amountBdt);
    else cBdt = cBdt.plus(it.amountBdt);
    costBdt = costBdt.plus(it.costBdt);
    discountBdt = discountBdt.plus(it.discountBdt);
  }

  const baseBdt = (s.taxBaseA ? aBdt : ZERO).plus(s.taxBaseB ? bBdt : ZERO).plus(s.taxBaseC ? cBdt : ZERO);
  const usdOfferBase = (s.taxBaseB ? bBdt : ZERO).plus(s.taxBaseC ? cBdt : ZERO);
  const t = taxes(baseBdt, s.aitPct, s.vatPct, s.taxMethod);
  const tu = taxes(usdOfferBase, s.aitPct, s.vatPct, s.taxMethod);
  const sell = aBdt.plus(bBdt).plus(cBdt);

  return {
    items,
    brandTotals,
    totals: {
      aBdt: r2(aBdt), aUsd: r2(aUsd), bBdt: r2(bBdt), cBdt: r2(cBdt),
      costBdt: r2(costBdt), discountBdt: r2(discountBdt),
      baseBdt: r2(baseBdt), aitBdt: r2(t.ait), vatBdt: r2(t.vat),
      grandTotalBdt: r2(sell.plus(s.addTaxToTotal ? t.ait.plus(t.vat) : ZERO)),
      usdOfferBase: r2(usdOfferBase), usdOfferAitBdt: r2(tu.ait), usdOfferVatBdt: r2(tu.vat),
      usdOfferTakaTotal: r2(bBdt.plus(cBdt).plus(s.addTaxToTotal ? tu.ait.plus(tu.vat) : ZERO)),
      profitBdt: r2(sell.minus(costBdt)),
    },
  };
}

// ---------- formatting (screen) ----------
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nfq = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
/** 1,234.50 — uses the decimal value rounded half-up first, so the screen shows what the file and DB store. */
export const fmt = (d: Dec | Num) => nf2.format(r2(d instanceof Dec ? d : dec(d as Num)).toNumber());
export const fmt0 = (d: Dec | Num) => nf0.format((d instanceof Dec ? d : dec(d as Num)).toDecimalPlaces(0).toNumber());
export const fmtQ = (d: Dec | Num) => nfq.format((d instanceof Dec ? d : dec(d as Num)).toDecimalPlaces(3).toNumber());
