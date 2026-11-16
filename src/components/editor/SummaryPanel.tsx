'use client';

import { fmt, type Totals } from '@/lib/calc';
import { inWordsTaka, inWordsUsd } from '@/lib/calc/words';
import type { BoqSettings } from '@/lib/boq/types';
import { numInput } from './ui';

interface Props {
  settings: BoqSettings;
  totals: Totals;
  project: string;
  readOnly: boolean;
  showCost: boolean;
  onChange: (patch: Partial<BoqSettings>) => void;
}

export function SummaryPanel({ settings: S, totals: T, project, readOnly, showCost, onChange }: Props) {
  const usd = S.offerCurrency === 'USD';
  const who = S.addTaxToTotal ? '' : ' (Provided by the Client.)';
  const tax = usd ? { ait: T.usdOfferAitBdt, vat: T.usdOfferVatBdt } : { ait: T.aitBdt, vat: T.vatBdt };
  const baseL = (usd ? (['B', 'C'] as const) : (['A', 'B', 'C'] as const))
    .filter((k) => S[`taxBase${k}` as 'taxBaseA']).join('+') || 'nothing';
  const sell = T.aBdt.plus(T.bBdt).plus(T.cBdt);
  const num = (k: keyof BoqSettings) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = numInput(e.target.value);
    if (v !== null) onChange({ [k]: v } as Partial<BoqSettings>);
  };

  const Row = ({ sl, d, duty, u, t }: { sl: string; d: React.ReactNode; duty: string; u: string; t: string }) => (
    <tr>
      <td className="c">{sl}</td>{d}<td className="n">{duty}</td><td className="c">Job</td><td className="c">1</td>
      {usd && <td className="n">{u}</td>}<td className="n">{t}</td>
    </tr>
  );

  return (
    <section className="panel" aria-label="Offer summary">
      <div className="sumgrid">
        <div className="sheet">
          <div className="seg" role="group" aria-label="Offer currency">
            <button type="button" aria-pressed={!usd} onClick={() => onChange({ offerCurrency: 'BDT' })} disabled={readOnly}>BDT offer</button>
            <button type="button" aria-pressed={usd} onClick={() => onChange({ offerCurrency: 'USD' })} disabled={readOnly}>USD offer</button>
          </div>
          <h2>Offer Summary <span className="curtag">{usd ? 'USD' : 'BDT'}</span></h2>
          <div className="p">Project : {project}</div>
          <div className="scroller" style={{ border: 'none' }}>
            <table className="offer">
              <thead><tr><th>SL</th><th>Description</th><th>Duties, VAT &amp; AIT (Taka)</th><th>Unit</th><th>Qty</th>{usd && <th>Amount USD</th>}<th>Amount Taka</th></tr></thead>
              <tbody>
                <Row sl="A" d={usd
                  ? <td className="dA">Supply of Import Items at CNF CTG.<small>(Currency exchange rate:1USD=Actual.) (L.C Open by the Client)</small></td>
                  : <td>Supply of Import Items Delivery at Site</td>}
                  duty="" u={usd ? fmt(T.aUsd) : ''} t={usd ? '' : fmt(T.aBdt)} />
                <Row sl="B" d={<td>Installation of Import Items, Supply &amp; Installation of Local Item for VRV A System.</td>} duty="" u="" t={fmt(T.bBdt)} />
                <Row sl="C" d={<td>Supply &amp; Installation of Ventilation system with local works</td>} duty="" u="" t={fmt(T.cBdt)} />
                <Row sl="D" d={<td>{`AIT x ${S.aitPct}% TK.${who}`}</td>} duty={S.addTaxToTotal ? '' : fmt(tax.ait)} u="" t={S.addTaxToTotal ? fmt(tax.ait) : ''} />
                <Row sl="E" d={<td>{`VAT x ${S.vatPct}% TK.${who}`}</td>} duty={S.addTaxToTotal ? '' : fmt(tax.vat)} u="" t={S.addTaxToTotal ? fmt(tax.vat) : ''} />
                <tr className="gt">
                  <td /><td>Grand Total</td><td /><td /><td />
                  {usd ? <><td className="n gtv">{fmt(T.aUsd)}</td><td className="n gtv">{fmt(T.usdOfferTakaTotal)}</td></>
                    : <td className="n gtv">{fmt(T.grandTotalBdt)}</td>}
                </tr>
              </tbody>
            </table>
          </div>
          <div className="words">
            {usd ? (<>
              <p><b>In word (USD) :</b> {inWordsUsd(T.aUsd)}</p>
              <p><b>In word (Taka) :</b> {inWordsTaka(T.usdOfferTakaTotal)}</p>
            </>) : <p><b>In word :</b> {inWordsTaka(T.grandTotalBdt)}</p>}
          </div>
          <p><b>Note :</b> {S.offerNote}</p>
        </div>

        <div className="side">
          <div className="box">
            <h3>AIT and VAT</h3>
            <div className="row2">
              <label className="f"><span className="lbl">AIT %</span><input inputMode="decimal" value={S.aitPct} onChange={num('aitPct')} disabled={readOnly} /></label>
              <label className="f"><span className="lbl">VAT %</span><input inputMode="decimal" value={S.vatPct} onChange={num('vatPct')} disabled={readOnly} /></label>
            </div>
            <label className="f"><span className="lbl">Calculation</span>
              <select value={S.taxMethod} onChange={(e) => onChange({ taxMethod: e.target.value as 'gross' | 'simple' })} disabled={readOnly}>
                <option value="gross">Gross-up (same as the Excel sheet)</option>
                <option value="simple">Simple % on base</option>
              </select>
            </label>
            <div className="formula">
              {S.taxMethod === 'gross'
                ? `AIT = (${baseL}) × ${S.aitPct} ÷ (100 − ${S.aitPct}) = ${fmt(tax.ait)}\nVAT = (${baseL} + AIT) × ${S.vatPct} ÷ (100 − ${S.vatPct}) = ${fmt(tax.vat)}`
                : `AIT = (${baseL}) × ${S.aitPct}% = ${fmt(tax.ait)}\nVAT = (${baseL} + AIT) × ${S.vatPct}% = ${fmt(tax.vat)}`}
            </div>
            <div><span className="lbl">Base includes</span>
              <div style={{ display: 'flex', gap: 14, marginTop: 4 }}>
                {(['A', 'B', 'C'] as const).map((k) => (
                  <label key={k} className="chk" style={{ opacity: usd && k === 'A' ? 0.45 : 1 }}>
                    <input type="checkbox" checked={S[`taxBase${k}`]} disabled={readOnly || (usd && k === 'A')}
                      onChange={(e) => onChange({ [`taxBase${k}`]: e.target.checked } as Partial<BoqSettings>)} /> {k}
                  </label>
                ))}
              </div>
            </div>
            <label className="chk"><input type="checkbox" checked={S.addTaxToTotal} disabled={readOnly} onChange={(e) => onChange({ addTaxToTotal: e.target.checked })} /> Add AIT &amp; VAT to grand total</label>
            <p className="hint">Off: AIT and VAT show in the duties column as “Provided by the Client”.</p>
            {usd && <p className="hint">USD offer: line A is imported on the client’s L.C, so AIT and VAT are worked out on B and C only.</p>}
          </div>

          {showCost && (
            <div className="box">
              <h3>Profit check (internal)</h3>
              <div className="kv"><span>Total cost</span><b>{fmt(T.costBdt)}</b></div>
              <div className="kv"><span>Total selling (A+B+C)</span><b>{fmt(sell)}</b></div>
              <div className="kv"><span>Discount given</span><b>{fmt(T.discountBdt)}</b></div>
              <div className="kv"><span>Profit</span><b>{fmt(T.profitBdt)}</b></div>
              <div className="kv"><span>Profit on cost</span><b>{T.costBdt.isZero() ? '—' : `${T.profitBdt.div(T.costBdt).mul(100).toDecimalPlaces(2).toString()} %`}</b></div>
            </div>
          )}

          <div className="box">
            <h3>Note on offer</h3>
            <textarea aria-label="Note on offer" value={S.offerNote} disabled={readOnly} maxLength={4000} onChange={(e) => onChange({ offerNote: e.target.value })} />
          </div>
        </div>
      </div>
    </section>
  );
}
