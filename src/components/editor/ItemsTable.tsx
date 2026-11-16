'use client';

import { dec, fmt, isBlank, type CalcResult } from '@/lib/calc';
import { groupRows } from '@/lib/boq/rows';
import type { BoqRow } from '@/lib/boq/types';
import { ICON, numInput } from './ui';

interface Props {
  kind: 'imp' | 'loc';
  rows: BoqRow[];
  view: 'boq' | 'list';
  query: string;
  calc: CalcResult;
  readOnly: boolean;
  showCost: boolean;
  onQty: (row: BoqRow, qty: string) => void;
  onLine: (row: BoqRow, line: 'B' | 'C') => void;
  onFollowLinks: (row: BoqRow) => void;
  onEdit: (row: BoqRow) => void;
  onRemove: (row: BoqRow) => void;
  onGoList: () => void;
}

export function ItemsTable(p: Props) {
  const { kind, rows, view, calc, readOnly } = p;
  const boq = view === 'boq';
  const cols = 6;
  const groups = groupRows(rows);

  const head = kind === 'imp'
    ? (boq ? ['Item', 'Qty', 'Rate USD', 'Amount USD', 'Amount Tk'] : ['Item', 'Unit', p.showCost ? 'Cost USD' : 'Rate USD', 'Qty', 'Amount Tk'])
    : (boq ? ['Item', 'Line', 'Qty', 'Rate Tk', 'Amount Tk'] : ['Item', 'Unit', p.showCost ? 'Cost Tk' : 'Rate Tk', 'Qty', 'Amount Tk']);
  const numericCol = (i: number) => (kind === 'imp' && boq ? i >= 1 : i >= 2);

  const pctNote = (r: BoqRow) => {
    const out: string[] = [];
    if (!isBlank(r.profitPct) && !(r.defaultProfitZero && dec(r.profitPct).isZero())) out.push(`profit ${r.profitPct}%`);
    if (!isBlank(r.discountPct)) out.push(`disc ${r.discountPct}%`);
    return p.showCost ? out : [];
  };

  const qtyCell = (r: BoqRow) => {
    const it = calc.items.get(r.key)!;
    const auto = r.qtyFollowsLinks;
    const shown = auto ? (it.qty.isZero() ? '' : it.qty.toString()) : (r.qty === '0' ? '' : r.qty);
    return (
      <>
        <input
          className="q" inputMode="decimal" placeholder="0" value={shown} disabled={readOnly}
          aria-label={`Quantity of ${r.model || r.description}`}
          onChange={(e) => { const v = numInput(e.target.value); if (v !== null) p.onQty(r, v); }}
        />
        {r.linkSources.length > 0 && (
          <span className="auto">
            {auto ? 'auto from pipe' : !readOnly && <button type="button" onClick={() => p.onFollowLinks(r)}>use pipe qty</button>}
          </span>
        )}
        <span className="unit">{r.unit}</span>
      </>
    );
  };

  const desc = (r: BoqRow) => (
    <td className="desc">
      <div className="nm">
        {r.description || <i>Untitled item</i>}
        {r.isCustom ? <span className="badge ed">Added</span> : r.isEdited ? <span className="badge ed">Edited</span> : null}
        {isBlank(r.cost) && <span className="badge np">No price</span>}
      </div>
      {kind === 'imp' && r.model && <div className="mdl">Model : {r.model}</div>}
      {kind === 'loc' && r.specs.length > 0 && <div className="mdl">{r.specs.join(' · ')}</div>}
      {kind === 'imp' && !boq && r.specs.length > 0 && (
        <details><summary>Specs</summary><ul>{r.specs.map((s, i) => <li key={i}>{s}</li>)}</ul></details>
      )}
    </td>
  );

  const actions = (r: BoqRow) => readOnly ? <td className="act" /> : (
    <td className="act">
      <button type="button" className="ib" title="Edit item" aria-label={`Edit ${r.model || r.description}`} onClick={() => p.onEdit(r)}>{ICON.edit}</button>
      {(boq || r.isCustom) && (
        <button type="button" className="ib del" title={r.isCustom ? 'Delete item' : 'Remove from this BOQ'} aria-label={`Remove ${r.model || r.description}`} onClick={() => p.onRemove(r)}>
          {r.isCustom ? ICON.del : ICON.remove}
        </button>
      )}
    </td>
  );

  const rateCell = (r: BoqRow) => {
    const it = calc.items.get(r.key)!;
    const notes = pctNote(r);
    const below = p.showCost && !isBlank(r.cost) && dec(r.cost).gt(0) && it.rate.lt(dec(r.cost));
    return (
      <td className="n calc">
        {fmt(it.rate)}
        {(notes.length > 0 || below) && <span className={`ovr${below ? ' bad' : ''}`}>{[below ? 'below cost' : '', ...notes].filter(Boolean).join(' · ')}</span>}
      </td>
    );
  };

  const costCell = (r: BoqRow) => {
    if (isBlank(r.cost)) {
      return <td className="n calc">{readOnly ? '—' : <button type="button" className="addp" onClick={() => p.onEdit(r)}>Add price</button>}</td>;
    }
    const notes = pctNote(r);
    return <td className="n calc">{fmt(r.cost)}{notes.length > 0 && <span className="ovr">{notes.join(' · ')}</span>}</td>;
  };

  const body: React.ReactNode[] = [];
  for (const g of groups) {
    body.push(
      <tr className="grp" key={`g:${g.group}`}><td colSpan={cols}>{g.group}
        {kind === 'loc' && !boq && g.groupLines.length > 0 && <span className="gl">{g.groupLines.join(' · ')}</span>}
      </td></tr>,
    );
    for (const t of g.types) {
      if (t.type) {
        body.push(
          <tr className="typ" key={`t:${g.group}:${t.type}`}><td colSpan={cols}>Type : {t.type}
            {!boq && t.typeLines.length > 0 && <span className="tl">{t.typeLines.join(' · ')}</span>}
          </td></tr>,
        );
      }
      for (const r of t.rows) {
        const it = calc.items.get(r.key)!;
        const has = it.qty.gt(0);
        body.push(
          <tr key={r.key} className={has && !boq ? 'used' : undefined}>
            {desc(r)}
            {kind === 'imp' && boq && (<>
              <td className="n">{qtyCell(r)}</td>
              {rateCell(r)}
              <td className="n calc">{has ? fmt(it.amountUsd!) : ''}</td>
              <td className="n calc strong">{has ? fmt(it.amountBdt) : ''}</td>
            </>)}
            {kind === 'loc' && boq && (<>
              <td>
                <select value={r.line} disabled={readOnly} aria-label={`Offer line for ${r.description}`} onChange={(e) => p.onLine(r, e.target.value as 'B' | 'C')}>
                  <option value="B">B</option><option value="C">C</option>
                </select>
              </td>
              <td className="n">{qtyCell(r)}</td>
              {rateCell(r)}
              <td className="n calc strong">{has ? fmt(it.amountBdt) : ''}</td>
            </>)}
            {!boq && (<>
              <td>{r.unit}</td>
              {p.showCost ? costCell(r) : rateCell(r)}
              <td className="n">{qtyCell(r)}</td>
              <td className="n calc strong">{has ? fmt(it.amountBdt) : ''}</td>
            </>)}
            {actions(r)}
          </tr>,
        );
      }
    }
  }

  return (
    <div className="scroller">
      <table className="boq">
        <thead><tr>
          {head.map((h, i) => <th key={h} className={numericCol(i) ? 'n' : undefined}>{h}</th>)}
          <th className="act"><span className="sr">Actions</span></th>
        </tr></thead>
        <tbody>
          {body.length ? body : (
            <tr className="empty"><td colSpan={cols}>
              {p.query ? `Nothing matches “${p.query}”.` : boq ? `No ${kind === 'imp' ? 'equipment' : 'local items'} in this BOQ yet.` : 'This list is empty.'}
              {boq && !p.query && !readOnly && <><br /><button type="button" className="btn" onClick={p.onGoList}>Open {kind === 'imp' ? 'price list' : 'full list'} to add quantities</button></>}
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
