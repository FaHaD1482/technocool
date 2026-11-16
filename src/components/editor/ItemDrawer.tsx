'use client';

import { useMemo, useState } from 'react';
import { calcItem, dec, fmt, isBlank, type CalcSettings } from '@/lib/calc';
import { differsFromCatalog, toCalcRow } from '@/lib/boq/rows';
import type { BoqRow, CatalogEntry } from '@/lib/boq/types';
import { Dialog } from '@/components/ui/Dialog';
import { normNum, numInput } from './ui';

interface Props {
  row: BoqRow;
  isNew: boolean;
  catalog?: CatalogEntry;
  settings: CalcSettings;
  canGiveDiscount: boolean;
  groups: string[];
  types: string[];
  onSave: (row: BoqRow) => void;
  onRemove: (row: BoqRow) => void;
  onClose: () => void;
}

interface Form {
  groupName: string; typeName: string; description: string; model: string; unit: string; specs: string;
  cost: string; profitPct: string; discountPct: string; qty: string; line: 'A' | 'B' | 'C';
}

const UNITS = ['Nos', 'Sets', 'Rft', 'Sft', 'Mtr', 'Kg', 'Job', 'Ton', 'Year'];

export function ItemDrawer({ row, isNew, catalog, settings, canGiveDiscount, groups, types, onSave, onRemove, onClose }: Props) {
  const isA = row.line === 'A';
  const [f, setF] = useState<Form>(() => ({
    groupName: row.groupName, typeName: row.typeName ?? '', description: row.description, model: row.model ?? '',
    unit: row.unit, specs: row.specs.join('\n'), cost: row.cost ?? '', profitPct: row.profitPct ?? '',
    discountPct: row.discountPct ?? '', qty: dec(row.qty).isZero() ? '' : row.qty, line: row.line,
  }));
  const [err, setErr] = useState<string | null>(null);

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));
  const setNum = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = numInput(e.target.value);
    if (v !== null) setF((p) => ({ ...p, [k]: v }));
  };

  const draft = useMemo((): BoqRow => {
    const specs = f.specs.split('\n').map((s) => s.trim()).filter(Boolean);
    const qtyTyped = normNum(f.qty, '0')!;
    const qtyChanged = !dec(qtyTyped).eq(dec(row.qty));
    return {
      ...row,
      line: f.line,
      groupName: f.groupName.trim() || row.groupName,
      typeName: isA ? (f.typeName.trim() || null) : row.typeName,
      description: f.description.trim(),
      model: isA ? (f.model.trim() || null) : row.model,
      unit: f.unit.trim() || 'Nos',
      specs,
      cost: normNum(f.cost, null),
      profitPct: canGiveDiscount ? normNum(f.profitPct, null) : row.profitPct,
      discountPct: canGiveDiscount ? normNum(f.discountPct, null) : row.discountPct,
      qty: qtyTyped,
      // typing a quantity on an insulation line stops it following the pipe sizes
      qtyFollowsLinks: row.qtyFollowsLinks && !qtyChanged,
    };
  }, [f, row, isA, canGiveDiscount]);

  const preview = calcItem(toCalcRow(draft), settings, dec(draft.qty));

  function save() {
    if (!draft.description) return setErr('Enter a description.');
    if (draft.discountPct !== null && dec(draft.discountPct).gt(100)) return setErr('Discount cannot be over 100%.');
    const isEdited = draft.isCustom ? false : differsFromCatalog(draft, catalog);
    onSave({ ...draft, isEdited });
  }

  function restore() {
    if (!catalog) return;
    setF((p) => ({
      ...p, groupName: catalog.groupName, typeName: catalog.typeName ?? '', description: catalog.description,
      model: catalog.model ?? '', unit: catalog.unit, specs: catalog.specs.join('\n'), cost: catalog.cost ?? '',
      profitPct: '', discountPct: '',
    }));
  }

  const costCur = isA ? 'USD' : 'Tk';
  const below = !isBlank(draft.cost) && preview.rate.lt(dec(draft.cost));

  return (
    <Dialog variant="sheet" labelledBy="eTitle" onClose={onClose}>
        <div className="dhd">
          <div>
            <h2 id="eTitle">{isNew ? 'Add item' : 'Edit item'}</h2>
            <p className="hint">{isNew ? 'A hand-added line for this BOQ only.' : 'Changes apply to this BOQ only, not the price list.'}</p>
          </div>
          <button className="x" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <form className="dbody" noValidate onSubmit={(e) => { e.preventDefault(); save(); }}>
          <div className="two">
            <label className="f"><span className="lbl">Group</span><input value={f.groupName} onChange={set('groupName')} list="eGroups" autoComplete="off" data-autofocus /></label>
            {isA && <label className="f"><span className="lbl">Type</span><input value={f.typeName} onChange={set('typeName')} list="eTypes" autoComplete="off" /></label>}
          </div>
          <label className="f"><span className="lbl">Description</span>
            <input value={f.description} onChange={set('description')} autoComplete="off" placeholder="e.g. Cooling capacity : 24,200 Btu/h / 7.1 kW" aria-invalid={err && !f.description.trim() ? true : undefined} />
          </label>
          <div className="two">
            {isA && <label className="f"><span className="lbl">Model</span><input value={f.model} onChange={set('model')} autoComplete="off" /></label>}
            <label className="f"><span className="lbl">Unit</span><input value={f.unit} onChange={set('unit')} list="eUnits" autoComplete="off" /></label>
          </div>
          <label className="f"><span className="lbl">Specifications <small>one per line</small></span><textarea rows={4} value={f.specs} onChange={set('specs')} /></label>
          <div className="three">
            <label className="f"><span className="lbl">Cost {costCur}</span><input inputMode="decimal" value={f.cost} onChange={setNum('cost')} autoComplete="off" placeholder="no price" /></label>
            <label className="f"><span className="lbl">Profit %</span><input inputMode="decimal" value={f.profitPct} onChange={setNum('profitPct')} placeholder={`default ${preview.profitPct.toString()}`} disabled={!canGiveDiscount} /></label>
            <label className="f"><span className="lbl">Discount %</span><input inputMode="decimal" value={f.discountPct} onChange={setNum('discountPct')} placeholder={`default ${preview.discountPct.toString()}`} disabled={!canGiveDiscount} /></label>
          </div>
          <div className="two">
            <label className="f"><span className="lbl">Qty in this BOQ</span><input inputMode="decimal" value={f.qty} onChange={setNum('qty')} placeholder={row.qtyFollowsLinks ? 'auto from pipe' : '0'} /></label>
            {!isA && (
              <label className="f"><span className="lbl">Offer line</span>
                <select value={f.line} onChange={set('line')}>
                  <option value="B">B · Local &amp; installation</option>
                  <option value="C">C · Ventilation</option>
                </select>
              </label>
            )}
          </div>
          <div className="preview" aria-live="polite">
            <span>Rate {isA ? 'USD' : 'Tk'} <b>{fmt(preview.rate)}</b></span>
            {isA && <span>Rate Tk <b>{fmt(preview.rateBdt)}</b></span>}
            <span>Amount Tk <b>{fmt(preview.amountBdt)}</b></span>
            {below && <span className="ovr bad">Selling below cost</span>}
            {preview.missingPrice && <span className="ovr bad">No price: rate is 0</span>}
          </div>
          {err && <p className="ferr" role="alert">{err}</p>}
          <button type="submit" hidden>Save</button>
        </form>
        <div className="dft">
          <div className="grow">
            {!isNew && (row.isCustom
              ? <button className="btn reset" type="button" onClick={() => onRemove(row)}>Delete item</button>
              : <button className="btn reset" type="button" onClick={() => onRemove(row)}>Remove from BOQ</button>)}
            {catalog && <button className="btn" type="button" onClick={restore}>Restore original</button>}
          </div>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn primary" type="button" onClick={save}>{isNew ? 'Add' : 'Save'}</button>
        </div>
      <datalist id="eGroups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
      <datalist id="eTypes">{types.map((t) => <option key={t} value={t} />)}</datalist>
      <datalist id="eUnits">{UNITS.map((u) => <option key={u} value={u} />)}</datalist>
    </Dialog>
  );
}
