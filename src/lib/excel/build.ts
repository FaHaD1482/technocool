import 'server-only';
import ExcelJS from 'exceljs';
import { calculate, dec, r2, type CalcResult, type Dec } from '@/lib/calc';
import { inWordsTaka, inWordsUsd } from '@/lib/calc/words';
import { groupRows, toCalcRow, toCalcSettings } from '@/lib/boq/rows';
import type { BoqHeader, BoqRow, BoqSettings, BrandDTO, OfferCurrency } from '@/lib/boq/types';
import { COSTING_SHEET } from './safety';

export { assertClientSafe, COSTING_SHEET } from './safety';

/**
 * Builds the editable Excel offer on the server (same layout as the prototype):
 *   Offer Summary · Imported Item · Local Item & Installation · Ventilation (only if line C has items)
 *   + "Costing (internal)" only when withCosting is true. A file meant for a client must use withCosting = false;
 *   assertClientSafe() double-checks that before anything is sent.
 */
export interface BuildInput {
  header: BoqHeader;
  settings: BoqSettings;
  rows: BoqRow[];
  brands: BrandDTO[];
  currency: OfferCurrency;
  withCosting: boolean;
}

const DESC_A_BDT = 'Supply of Import Items Delivery at Site';
const DESC_A_USD = 'Supply of Import Items at CNF CTG. (Currency exchange rate:1USD=Actual.) (L.C Open by the Client)';

const XL = {
  border: { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } } as Partial<ExcelJS.Borders>,
  head: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF9DC3E6' } } as ExcelJS.Fill,
  grand: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } } as ExcelJS.Fill,
  money: '#,##0.00',
};
const PAGE = { paperSize: 9 as const, fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

const colLetter = (n: number) => { let s = ''; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const num = (d: Dec) => d.toNumber();

function sheetBase(ws: ExcelJS.Worksheet, title: string, project: string, cols: number[], headers: string[]) {
  ws.columns = cols.map((w) => ({ width: w }));
  ws.mergeCells(`A1:${colLetter(cols.length)}1`);
  const t = ws.getCell('A1'); t.value = title; t.font = { bold: true, size: 14, underline: true }; t.alignment = { horizontal: 'center' };
  ws.getCell('A2').value = 'Project : ' + project; ws.getCell('A2').font = { bold: true };
  const hr = ws.getRow(4);
  headers.forEach((h, i) => {
    const c = hr.getCell(i + 1); c.value = h; c.font = { bold: true }; c.fill = XL.head; c.border = XL.border;
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  hr.height = 30;
}
const boxRow = (ws: ExcelJS.Worksheet, r: number, n: number) => { for (let i = 1; i <= n; i++) ws.getCell(r, i).border = XL.border; };

interface SheetItem { g: string; gs: string[]; t: string; ts: string[]; n: string; m: string | null; s: string[]; u: string; qty: number; rate: number }

/** Writes grouped item rows with formula amounts; returns the address of the total cell. */
function writeItems(ws: ExcelJS.Worksheet, rows: SheetItem[], o: { cols: number; typeLines?: string[]; total: number; words: (x: number) => string }) {
  const n = o.cols, first = 5;
  let r = 5, gi = 0, ti = 0, ii = 0, lastG: string | null = null, lastT: string | null = null;
  const specRow = (txt: string) => { ws.getCell(r, 2).value = txt; ws.getCell(r, 2).alignment = { wrapText: true }; boxRow(ws, r, n); r++; };
  for (const it of rows) {
    if (it.g !== lastG) {
      gi++; ti = 0; ii = 0; lastG = it.g; lastT = null;
      ws.getCell(r, 1).value = String(gi); ws.getCell(r, 2).value = it.g; ws.getRow(r).font = { bold: true }; boxRow(ws, r, n); r++;
      it.gs.forEach(specRow);
    }
    if (it.t && it.t !== lastT) {
      ti++; ii = 0; lastT = it.t;
      const parts = it.t.split(' · ');
      const extra = parts.filter((x, i) => i > 0 && /remote controller/i.test(x));
      const base = parts.filter((x, i) => i === 0 || !/remote controller/i.test(x)).join(' · ');
      ws.getCell(r, 1).value = `${gi}.${ti}`; ws.getCell(r, 2).value = 'Type : ' + base; ws.getCell(r, 2).font = { bold: true }; boxRow(ws, r, n); r++;
      (it.ts.length ? it.ts : (o.typeLines ?? [])).forEach(specRow);
      extra.forEach(specRow);
    }
    ii++;
    ws.getCell(r, 1).value = it.t ? `${gi}.${ti}.${ii}` : `${gi}.${ii}`;
    const d = ws.getCell(r, 2); d.value = it.n; d.alignment = { wrapText: true }; d.font = { bold: true };
    ws.getCell(r, 3).value = it.u; ws.getCell(r, 4).value = it.qty;
    ws.getCell(r, 5).value = it.rate; ws.getCell(r, 5).numFmt = XL.money;
    ws.getCell(r, 6).value = { formula: `D${r}*E${r}`, result: num(dec(it.rate).mul(it.qty)) }; ws.getCell(r, 6).numFmt = XL.money;
    boxRow(ws, r, n); r++;
    if (it.m) specRow('Model : ' + it.m);
    it.s.forEach(specRow);
  }
  const last = r - 1; r++;
  ws.getCell(r, 2).value = 'Total'; ws.getCell(r, 2).font = { bold: true };
  const tc = ws.getCell(r, 6);
  tc.value = { formula: `SUM(F${first}:F${Math.max(first, last)})`, result: o.total }; tc.numFmt = XL.money; tc.font = { bold: true };
  boxRow(ws, r, n);
  const totalCell = `F${r}`; r++;
  ws.getCell(r, 1).value = 'In words : ' + o.words(o.total); ws.mergeCells(r, 1, r, n);
  return totalCell;
}

function flatten(rows: BoqRow[], calc: CalcResult, rateOf: (key: string) => Dec, noTypeFor?: (g: string) => boolean): SheetItem[] {
  const out: SheetItem[] = [];
  for (const g of groupRows(rows)) for (const t of g.types) for (const r of t.rows) {
    const it = calc.items.get(r.key)!;
    out.push({
      g: g.group, gs: g.groupLines, t: noTypeFor?.(g.group) ? '' : (t.type ?? ''), ts: t.typeLines,
      n: r.description, m: r.model, s: r.specs, u: r.unit, qty: num(it.qty.toDecimalPlaces(3)), rate: num(r2(rateOf(r.key))),
    });
  }
  return out;
}

export async function buildWorkbook(input: BuildInput): Promise<ExcelJS.Workbook> {
  const { header, settings: S, currency, withCosting } = input;
  const usd = currency === 'USD';
  const calc = calculate(input.rows.map(toCalcRow), toCalcSettings(S));
  const T = calc.totals;
  const brand = input.brands.find((b) => b.id === S.selectedBrandId);
  const project = [header.projectName, header.siteAddress].filter(Boolean).join(', ');
  const has = (r: BoqRow) => calc.items.get(r.key)!.qty.gt(0);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'HVAC BOQ System';
  wb.created = new Date();
  const sum = wb.addWorksheet('Offer Summary', { pageSetup: { ...PAGE, orientation: 'portrait' } });

  // ---- Imported (selected brand only) ----
  const impRows = input.rows.filter((r) => r.line === 'A' && r.brandId === S.selectedBrandId && has(r));
  const noType = (g: string) => g === 'Freight' || g.startsWith('Additional');
  const wsI = wb.addWorksheet('Imported Item', { pageSetup: PAGE });
  let impTotal: string;
  if (usd) {
    sheetBase(wsI, 'BOQ OF IMPORTED ITEM FOR HVAC SYSTEM', project, [7, 58, 7, 7, 14, 17], ['Sl.', 'Items', 'Unit', 'Qty', 'Rate USD', 'Amount USD']);
    wsI.getCell('A3').value = 'Supply of Imported Item at CNF CTG. (Currency exchange rate:1USD=Actual.) (L.C Open by the Client)'; wsI.getCell('A3').font = { bold: true };
    impTotal = writeItems(wsI, flatten(impRows, calc, (k) => calc.items.get(k)!.rate, noType), { cols: 6, typeLines: brand?.typeLines, total: num(T.aUsd), words: inWordsUsd });
  } else {
    sheetBase(wsI, 'BOQ OF IMPORTED ITEM FOR HVAC SYSTEM', project, [7, 58, 7, 7, 14, 18], ['Sl.', 'Items', 'Unit', 'Qty', 'Rate', 'Amount']);
    wsI.getCell('A3').value = 'Supply of Imported Item'; wsI.getCell('A3').font = { bold: true };
    impTotal = writeItems(wsI, flatten(impRows, calc, (k) => calc.items.get(k)!.rateBdt, noType), { cols: 6, typeLines: brand?.typeLines, total: num(T.aBdt), words: inWordsTaka });
  }

  // ---- Local + ventilation ----
  const mkLocal = (name: string, title: string, sub: string, rows: BoqRow[], total: Dec) => {
    const ws = wb.addWorksheet(name, { pageSetup: PAGE });
    sheetBase(ws, title, project, [7, 62, 7, 9, 13, 17], ['Sl.', 'Items', 'Unit', 'Qty', 'Rate', 'Amount']);
    ws.getCell('A3').value = sub; ws.getCell('A3').font = { bold: true };
    return writeItems(ws, flatten(rows, calc, (k) => calc.items.get(k)!.rate), { cols: 6, total: num(total), words: inWordsTaka });
  };
  const bRows = input.rows.filter((r) => r.line === 'B' && has(r));
  const cRows = input.rows.filter((r) => r.line === 'C' && has(r));
  const bCell = mkLocal('Local Item & Installation', 'BOQ OF LOCAL ITEM FOR HVAC SYSTEM', 'Supply & Installation of Local Item', bRows, T.bBdt);
  const cCell = cRows.length ? mkLocal('Ventilation', 'BOQ OF VENTILATION SYSTEM', 'Supply & Installation of Ventilation system with local works', cRows, T.cBdt) : null;

  // ---- Offer summary ----
  const ws = sum, L = colLetter;
  const nC = usd ? 10 : 9, TK = usd ? 10 : 9, UC = 9, RK = usd ? 12 : 11, RV = RK + 1;
  ws.columns = (usd ? [6, 22, 22, 12, 12, 18, 7, 6, 16, 18, 3, 10, 9] : [6, 22, 22, 12, 12, 18, 7, 6, 20, 3, 10, 9]).map((w) => ({ width: w }));
  ws.mergeCells(`A2:${L(nC)}2`); const h2 = ws.getCell('A2'); h2.value = 'Offer Summary'; h2.font = { bold: true, size: 16, underline: true }; h2.alignment = { horizontal: 'center' };
  ws.mergeCells(`A3:${L(nC)}3`); ws.getCell('A3').value = 'Project : ' + project; ws.getCell('A3').font = { bold: true, size: 12 };
  ws.getCell(`A4`).value = `Ref : ${header.boqNo} R${header.revision}`; ws.getCell('A4').font = { italic: true, size: 10 };
  const H: [string, string, string][] = [['A5', 'A6', 'SL'], ['B5', 'E6', 'Description'], ['F5', 'F6', 'Duties, VAT & AIT (Taka)'], ['G5', 'G6', 'Unit'], ['H5', 'H6', 'Qty'],
    ...(usd ? [['I5', 'I6', 'Amount USD'], ['J5', 'J6', 'Amount Taka']] as [string, string, string][] : [['I5', 'I6', 'Amount Taka']] as [string, string, string][])];
  H.forEach(([a, b, t]) => { ws.mergeCells(`${a}:${b}`); const c = ws.getCell(a); c.value = t; c.font = { bold: true }; c.fill = XL.head; c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; });
  for (let rr = 5; rr <= 6; rr++) boxRow(ws, rr, nC);
  const ref = (sheet: string, cell: string) => `'${sheet}'!${cell}`;
  const who = S.addTaxToTotal ? '' : ' (Provided by the Client.)';
  const lines: [string, string, number, ExcelJS.CellValue][] = [
    ['A', usd ? DESC_A_USD : DESC_A_BDT, usd ? UC : TK, { formula: ref('Imported Item', impTotal), result: num(usd ? T.aUsd : T.aBdt) }],
    ['B', 'Installation of Import Items, Supply & Installation of Local Item for VRV A System.', TK, { formula: ref('Local Item & Installation', bCell), result: num(T.bBdt) }],
    ['C', 'Supply & Installation of Ventilation system with local works', TK, cCell ? { formula: ref('Ventilation', cCell), result: num(T.cBdt) } : 0],
  ];
  lines.forEach(([sl, d, c, v], i) => {
    const r = 7 + i;
    ws.getCell(r, 1).value = sl; ws.mergeCells(r, 2, r, 5); ws.getCell(r, 2).value = d; ws.getCell(r, 2).alignment = { wrapText: true, vertical: 'middle' };
    ws.getCell(r, 7).value = 'Job'; ws.getCell(r, 8).value = 1; ws.getCell(r, c).value = v; ws.getCell(r, c).numFmt = XL.money;
    ws.getRow(r).height = usd && sl === 'A' ? 48 : 32; boxRow(ws, r, nC);
  });
  // rates block (drives the AIT / VAT formulas so the file stays editable)
  ws.getCell(6, RK).value = 'Rates'; ws.getCell(6, RK).font = { bold: true };
  ws.getCell(7, RK).value = 'AIT %'; ws.getCell(7, RV).value = num(dec(S.aitPct));
  ws.getCell(8, RK).value = 'VAT %'; ws.getCell(8, RV).value = num(dec(S.vatPct));
  const aitR = `${L(RV)}7`, vatR = `${L(RV)}8`;
  const baseKeys = usd ? ['B', 'C'] : ['A', 'B', 'C'];
  const baseOn = { A: S.taxBaseA, B: S.taxBaseB, C: S.taxBaseC } as Record<string, boolean>;
  const baseParts = baseKeys.filter((k) => baseOn[k]).map((k) => `${L(TK)}${7 + 'ABC'.indexOf(k)}`);
  const base = baseParts.length ? baseParts.join('+') : '0';
  const col = S.addTaxToTotal ? TK : 6, aitCell = `${L(col)}10`;
  const gross = S.taxMethod === 'gross';
  const aitF = gross ? `(${base})*${aitR}/(100-${aitR})` : `(${base})*${aitR}/100`;
  const vatF = gross ? `((${base})+${aitCell})*${vatR}/(100-${vatR})` : `((${base})+${aitCell})*${vatR}/100`;
  const tx = usd ? { ait: T.usdOfferAitBdt, vat: T.usdOfferVatBdt } : { ait: T.aitBdt, vat: T.vatBdt };
  ([[10, 'D', `AIT x ${S.aitPct}% TK.${who}`, aitF, tx.ait], [11, 'E', `VAT x ${S.vatPct}% TK.${who}`, vatF, tx.vat]] as const).forEach(([r, sl, d, f, v]) => {
    ws.getCell(r, 1).value = sl; ws.mergeCells(r, 2, r, 5); ws.getCell(r, 2).value = d; ws.getCell(r, 2).alignment = { wrapText: true, vertical: 'middle' };
    ws.getCell(r, col).value = { formula: f, result: num(v) }; ws.getCell(r, col).numFmt = XL.money;
    ws.getCell(r, 7).value = 'Job'; ws.getCell(r, 8).value = 1; ws.getRow(r).height = 32; boxRow(ws, r, nC);
  });
  ws.mergeCells('B12:E12'); ws.getCell('B12').value = 'Grand Total'; ws.getCell('B12').font = { bold: true, size: 12 };
  const gt = (c: number, f: string, v: Dec) => { const cell = ws.getCell(12, c); cell.value = { formula: f, result: num(v) }; cell.numFmt = XL.money; cell.font = { bold: true, size: 12 }; cell.fill = XL.grand; };
  if (usd) { gt(UC, 'I7', T.aUsd); gt(TK, 'SUM(J7:J11)', T.usdOfferTakaTotal); } else gt(TK, 'SUM(I7:I11)', T.grandTotalBdt);
  ws.getRow(12).height = 26; boxRow(ws, 12, nC);
  const wordRows = usd
    ? ['In word (USD) : ' + inWordsUsd(T.aUsd), 'In word (Taka) : ' + inWordsTaka(T.usdOfferTakaTotal)]
    : ['In word : ' + inWordsTaka(T.grandTotalBdt)];
  let wr = 14;
  for (const t of wordRows) { ws.mergeCells(wr, 1, wr, nC); const c = ws.getCell(wr, 1); c.value = t; c.font = { bold: true }; c.alignment = { wrapText: true }; ws.getRow(wr).height = 32; wr++; }
  ws.mergeCells(wr, 1, wr, nC); ws.getCell(wr, 1).value = 'Note : ' + (S.offerNote || ''); ws.getCell(wr, 1).alignment = { wrapText: true }; ws.getRow(wr).height = 30;
  for (let rr = 7; rr <= 11; rr++) for (const c of [1, 7, 8]) ws.getCell(rr, c).alignment = { horizontal: 'center', vertical: 'middle' };

  // ---- Costing (internal only) ----
  if (withCosting) {
    const wc = wb.addWorksheet(COSTING_SHEET);
    wc.columns = [['Line', 6], ['Group', 30], ['Item', 46], ['Model', 20], ['Unit', 7], ['Qty', 8], ['Cost USD', 11], ['Cost Tk / unit', 14], ['Profit %', 9], ['Disc %', 8], ['Rate Tk / unit', 14], ['Cost total Tk', 16], ['Selling total Tk', 16], ['Profit Tk', 15]]
      .map(([header, width]) => ({ header: header as string, width: width as number }));
    wc.getRow(1).eachCell((c) => { c.font = { bold: true }; c.fill = XL.head; c.border = XL.border; c.alignment = { wrapText: true, vertical: 'middle' }; });
    wc.getRow(1).height = 30;
    const fx = dec(S.exchangeRate);
    let r = 2;
    const put = (vals: [string, string, string, string, string, number, number | '', number, number, number, number]) => {
      const row = wc.getRow(r);
      vals.forEach((v, i) => { row.getCell(i + 1).value = v; row.getCell(i + 1).border = XL.border; });
      [7, 8, 11].forEach((i) => (row.getCell(i).numFmt = XL.money));
      const [q, costU, rateU] = [vals[5], vals[7], vals[10]];
      row.getCell(12).value = { formula: `F${r}*H${r}`, result: q * costU };
      row.getCell(13).value = { formula: `F${r}*K${r}`, result: q * rateU };
      row.getCell(14).value = { formula: `M${r}-L${r}`, result: q * (rateU - costU) };
      [12, 13, 14].forEach((i) => { row.getCell(i).numFmt = XL.money; row.getCell(i).border = XL.border; });
      r++;
    };
    for (const x of impRows) {
      const c = calc.items.get(x.key)!;
      put(['A', x.groupName, x.typeName ? `${x.typeName} · ${x.description}` : x.description, x.model ?? '', x.unit, num(c.qty), num(dec(x.cost)), num(r2(dec(x.cost).mul(fx))), num(c.profitPct), num(c.discountPct), num(c.rateBdt)]);
    }
    for (const x of [...bRows, ...cRows]) {
      const c = calc.items.get(x.key)!;
      put([x.line, x.groupName, x.description, '', x.unit, num(c.qty), '', num(dec(x.cost)), num(c.profitPct), num(c.discountPct), num(c.rate)]);
    }
    wc.getCell(r, 3).value = 'Total'; wc.getCell(r, 3).font = { bold: true };
    ([['L', T.costBdt], ['M', T.aBdt.plus(T.bBdt).plus(T.cBdt)], ['N', T.profitBdt]] as const).forEach(([c, v]) => {
      const cell = wc.getCell(`${c}${r}`); cell.value = { formula: `SUM(${c}2:${c}${Math.max(2, r - 1)})`, result: num(v) }; cell.numFmt = XL.money; cell.font = { bold: true };
    });
    wc.getCell(r + 1, 3).value = 'Discount given Tk'; wc.getCell(r + 1, 13).value = num(T.discountBdt); wc.getCell(r + 1, 13).numFmt = XL.money;
    wc.getCell(r + 2, 1).value = `Exchange rate used: ${S.exchangeRate} Tk/USD. Internal sheet: never send to the client.`;
  }

  return wb;
}

export function exportFileName(header: BoqHeader, brand: string | undefined, currency: OfferCurrency, withCosting: boolean) {
  const safe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${safe(header.boqNo)} R${header.revision} ${safe(header.projectName)} ${brand ?? ''}${withCosting ? ' with costing' : ''} (${currency}).xlsx`
    .replace(/\s+/g, ' ');
}
