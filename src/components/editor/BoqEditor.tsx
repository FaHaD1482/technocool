'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { calculate, dec, fmt, fmt0 } from '@/lib/calc';
import { mergeWithCatalog, rowFromCatalog, shouldPersist, sortRows, textMatch, toCalcRow, toCalcSettings } from '@/lib/boq/rows';
import type { BoqRow, BoqSettings, CatalogEntry, EditorData, ExportChoice } from '@/lib/boq/types';
import { ItemDrawer } from './ItemDrawer';
import { ItemsTable } from './ItemsTable';
import { SendDialog } from './SendDialog';
import { SendLog } from './SendLog';
import type { EmailSummary } from '@/lib/mail/send';
import type { Reply } from '@/lib/replies';
import { RepliesPanel } from './RepliesPanel';
import { SummaryPanel } from './SummaryPanel';
import { normNum, numInput, useDismiss, useToast } from './ui';
import { BOQ_STATUS, chipOf, labelOf } from '@/lib/labels';

type Tab = 'imported' | 'local' | 'summary';
type SaveState = { kind: 'saved' | 'dirty' | 'saving' | 'error' | 'stale'; text: string };

export function BoqEditor({ data, emails = [], replies = [], canMail = false }: { data: EditorData; emails?: EmailSummary[]; replies?: Reply[]; canMail?: boolean }) {
  const router = useRouter();
  const { header, perms, brands } = data;
  const readOnly = !perms.canEdit;
  const toast = useToast();

  const catalogByProduct = useMemo(() => new Map<string, CatalogEntry>(data.catalog.map((c) => [c.productId, c])), [data.catalog]);
  const [settings, setSettings] = useState<BoqSettings>(data.settings);
  const [rows, setRows] = useState<BoqRow[]>(() => mergeWithCatalog(data.rows, data.catalog));
  const [tab, setTab] = useState<Tab>('imported');
  const [impView, setImpView] = useState<'boq' | 'list'>(data.rows.some((r) => r.line === 'A') || readOnly ? 'boq' : 'list');
  const [locView, setLocView] = useState<'boq' | 'list'>(data.rows.some((r) => r.line !== 'A') || readOnly ? 'boq' : 'list');
  const [impQ, setImpQ] = useState('');
  const [locQ, setLocQ] = useState('');
  const [editing, setEditing] = useState<{ row: BoqRow; isNew: boolean } | null>(null);
  const [exportChoice, setExportChoice] = useState<ExportChoice>(data.settings.offerCurrency);
  const [exporting, setExporting] = useState(false);
  const [dockOpen, setDockOpen] = useState(false);
  const [save, setSave] = useState<SaveState>({ kind: 'saved', text: 'All changes saved' });
  const [sendOpen, setSendOpen] = useState(false);
  const [pollKey, setPollKey] = useState(0);

  const calcSettings = useMemo(() => toCalcSettings(settings), [settings]);
  const calc = useMemo(() => calculate(rows.map(toCalcRow), calcSettings), [rows, calcSettings]);
  const T = calc.totals;
  const brand = brands.find((b) => b.id === settings.selectedBrandId);

  // ------------------------------------------------------------------ autosave
  const version = useRef(header.version);
  const dirty = useRef(0);        // bumps on every change
  const savedAt = useRef(0);      // value of dirty that is safely stored
  const inFlight = useRef<Promise<boolean> | null>(null);
  const latest = useRef({ rows, settings, calc });
  const dock = useRef<HTMLDivElement>(null);

  // The page reserves exactly as much room as the dock actually takes: it grows to three rows on a phone.
  useEffect(() => {
    const el = dock.current;
    if (!el) return;
    const root = document.documentElement;
    const sync = () => root.style.setProperty('--dock-h', `${Math.ceil(el.getBoundingClientRect().height)}px`);
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    window.addEventListener('resize', sync);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', sync);
      root.style.removeProperty('--dock-h');
    };
  }, []);
  latest.current = { rows, settings, calc };

  const markDirty = useCallback(() => { dirty.current++; setSave({ kind: 'dirty', text: 'Unsaved changes' }); }, []);

  /** The PUT body. Shared by the debounced save and by the "leaving the page" flush. */
  const payloadFor = useCallback((rs: BoqRow[], st: BoqSettings, c: ReturnType<typeof calculate>, ver: string) => ({
    version: ver,
    settings: {
      ...st, exchangeRate: normNum(st.exchangeRate, null),
      impProfitPct: normNum(st.impProfitPct, '0')!, impDiscountPct: normNum(st.impDiscountPct, '0')!,
      locProfitPct: normNum(st.locProfitPct, '0')!, locDiscountPct: normNum(st.locDiscountPct, '0')!,
      aitPct: normNum(st.aitPct, '0')!, vatPct: normNum(st.vatPct, '0')!,
    },
    rows: rs.filter((r) => shouldPersist(r, c.items.get(r.key)!.qty)).map((r) => ({
      ...r, qty: normNum(r.qty, '0')!, cost: normNum(r.cost, null),
      profitPct: normNum(r.profitPct, null), discountPct: normNum(r.discountPct, null),
    })),
  }), []);

  const doSave = useCallback(async (): Promise<boolean> => {
    if (readOnly) return true;
    if (inFlight.current) { await inFlight.current; }
    if (savedAt.current === dirty.current) return true;
    const target = dirty.current;
    const { rows: rs, settings: st, calc: c } = latest.current;
    const fx = normNum(st.exchangeRate, null);
    if (!fx || dec(fx).lte(0)) { setSave({ kind: 'error', text: 'Not saved: exchange rate must be above 0' }); return false; }
    const payload = payloadFor(rs, st, c, version.current);
    setSave({ kind: 'saving', text: 'Saving…' });
    const run = (async () => {
      try {
        const res = await fetch(`/api/boqs/${header.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (body.code === 'stale') setSave({ kind: 'stale', text: 'Changed in another window' });
          else setSave({ kind: 'error', text: `Not saved: ${body.error ?? res.statusText}` });
          return false;
        }
        version.current = body.version;
        // Lines stored for the first time now have an id; lines no longer stored lose theirs.
        const persisted = new Set(payload.rows.map((r) => r.key));
        setRows((prev) => prev.map((r) => {
          const id = body.keys[r.key];
          if (id && r.itemId !== id) return { ...r, itemId: id };
          if (!persisted.has(r.key) && r.itemId) return { ...r, itemId: null };
          return r;
        }));
        savedAt.current = target;
        setSave(dirty.current === target ? { kind: 'saved', text: 'All changes saved' } : { kind: 'dirty', text: 'Unsaved changes' });
        return true;
      } catch {
        setSave({ kind: 'error', text: 'Not saved: no connection. Retrying on your next change.' });
        return false;
      }
    })();
    inFlight.current = run;
    const ok = await run;
    inFlight.current = null;
    return ok;
  }, [header.id, readOnly, payloadFor]);

  // debounce: save 600 ms after the last change
  useEffect(() => {
    if (save.kind !== 'dirty') return;
    const t = setTimeout(() => { void doSave(); }, 600);
    return () => clearTimeout(t);
  }, [rows, settings, save.kind, doSave]);

  /**
   * Leaving the page must not lose the last edits. `beforeunload` only covers reload/close, so:
   *  - a keepalive PUT on unmount (in-app navigation), and
   *  - one when the tab is hidden (mobile backgrounding / closing).
   */
  const flushNow = useCallback(() => {
    if (readOnly || savedAt.current === dirty.current) return;
    const { rows: rs, settings: st, calc: c } = latest.current;
    try {
      void fetch(`/api/boqs/${header.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadFor(rs, st, c, version.current)), keepalive: true,
      });
    } catch { /* best effort; the next visit shows the last saved state */ }
  }, [readOnly, header.id, payloadFor]);

  useEffect(() => () => { flushNow(); }, [flushNow]);

  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') flushNow(); };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [flushNow]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (savedAt.current !== dirty.current) { e.preventDefault(); } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  // ------------------------------------------------------------------ edits
  const patchSettings = useCallback((patch: Partial<BoqSettings>) => {
    if (readOnly) return;
    setSettings((s) => ({ ...s, ...patch }));
    markDirty();
  }, [readOnly, markDirty]);

  const patchRow = useCallback((key: string, patch: Partial<BoqRow>) => {
    if (readOnly) return;
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    markDirty();
  }, [readOnly, markDirty]);

  const onQty = (r: BoqRow, qty: string) => patchRow(r.key, { qty, qtyFollowsLinks: false });
  const onFollowLinks = (r: BoqRow) => patchRow(r.key, { qtyFollowsLinks: true, qty: '0' });

  function removeRow(r: BoqRow) {
    if (readOnly) return;
    const before = rows;
    if (r.isCustom) {
      setRows((rs) => rs.filter((x) => x.key !== r.key));
    } else {
      const c = r.productId ? catalogByProduct.get(r.productId) : undefined;
      const reset = c ? { ...rowFromCatalog(c), key: r.key, itemId: r.itemId } : { ...r, qty: '0', qtyFollowsLinks: false };
      setRows((rs) => rs.map((x) => (x.key === r.key ? reset : x)));
    }
    markDirty();
    setEditing(null);
    toast.show(`Removed ${r.model || r.description.slice(0, 40)}`, { label: 'Undo', run: () => { setRows(before); markDirty(); } });
  }

  function addItem(kind: 'imp' | 'loc') {
    const row: BoqRow = {
      key: `c:${crypto.randomUUID()}`, itemId: null, productId: null, priceListId: null,
      line: kind === 'imp' ? 'A' : 'B', brandId: kind === 'imp' ? settings.selectedBrandId : null,
      isCustom: true, isEdited: false, groupName: kind === 'imp' ? 'Additional imported items' : 'Additional local items',
      groupLines: [], typeName: null, typeLines: [], description: '', model: null, unit: 'Nos', specs: [],
      cost: null, qty: '1', qtyFollowsLinks: false, linkSources: [], profitPct: null, discountPct: null,
      defaultProfitZero: false, sortOrder: 0,
    };
    setEditing({ row, isNew: true });
  }

  function saveDrawer(row: BoqRow) {
    setRows((rs) => {
      const exists = rs.some((r) => r.key === row.key);
      if (exists) return rs.map((r) => (r.key === row.key ? row : r));
      const maxSort = Math.max(0, ...rs.filter((r) => r.isCustom).map((r) => r.sortOrder));
      return sortRows([...rs, { ...row, sortOrder: maxSort + 1 }]);
    });
    markDirty();
    setEditing(null);
    if (row.line === 'A') setImpView('boq'); else setLocView('boq');
  }

  // ------------------------------------------------------------------ export / revision
  async function runExport(withCosting: boolean) {
    setExporting(true);
    try {
      if (!(await doSave())) { toast.show('Save failed, so the file was not made. Fix the problem above and try again.'); return; }
      const res = await fetch(`/api/boqs/${header.id}/export`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currency: exportChoice, withCosting }),
      });
      const body = await res.json();
      if (!res.ok) { toast.show(body.error ?? 'Export failed.'); return; }
      for (const f of body.files as { id: string }[]) {
        const a = document.createElement('a');
        a.href = `/api/exports/${f.id}`; a.rel = 'noopener';
        document.body.appendChild(a); a.click(); a.remove();
        await new Promise((r) => setTimeout(r, 400));   // browsers drop back-to-back downloads
      }
      const z = body.zeroRateLines as string[];
      toast.show(z.length
        ? `Downloaded. ${z.length} line${z.length > 1 ? 's have' : ' has'} no price, so the rate is 0. Sending will be blocked until it is fixed.`
        : `Downloaded ${body.files.length > 1 ? 'USD and BDT files' : 'the file'}.`, undefined, 8000);
    } finally {
      setExporting(false);
    }
  }

  async function newRevision() {
    const res = await fetch(`/api/boqs/${header.id}/revision`, { method: 'POST' });
    const body = await res.json();
    if (!res.ok) { toast.show(body.error ?? 'Could not create a revision.'); return; }
    router.push(`/boqs/${body.id}`);
  }

  // ------------------------------------------------------------------ derived lists
  const impAll = rows.filter((r) => r.line === 'A' && r.brandId === settings.selectedBrandId);
  const locAll = rows.filter((r) => r.line !== 'A');
  const qtyOf = (r: BoqRow) => calc.items.get(r.key)!.qty;
  const impUsed = impAll.filter((r) => qtyOf(r).gt(0));
  const locUsed = locAll.filter((r) => qtyOf(r).gt(0));
  const impShown = (impView === 'boq' ? impUsed : impAll).filter((r) => textMatch(r, impQ.trim().toLowerCase()));
  const locShown = (locView === 'boq' ? locUsed : locAll).filter((r) => textMatch(r, locQ.trim().toLowerCase()));
  const noPriceUsed = [...impUsed, ...locUsed].filter((r) => calc.items.get(r.key)!.missingPrice);
  const impCost = impUsed.reduce((a, r) => a.plus(calc.items.get(r.key)!.costBdt), dec(0));
  const impDisc = impUsed.reduce((a, r) => a.plus(calc.items.get(r.key)!.discountBdt), dec(0));
  const locCost = locUsed.reduce((a, r) => a.plus(calc.items.get(r.key)!.costBdt), dec(0));
  const locDisc = locUsed.reduce((a, r) => a.plus(calc.items.get(r.key)!.discountBdt), dec(0));
  const groups = useMemo(() => [...new Set(rows.map((r) => r.groupName))], [rows]);
  const types = useMemo(() => [...new Set(rows.map((r) => r.typeName).filter(Boolean) as string[])], [rows]);
  const project = [header.projectName, header.siteAddress].filter(Boolean).join(', ');
  const usdOffer = settings.offerCurrency === 'USD';

  const tableProps = {
    calc, readOnly, showCost: perms.canSeeCost, onQty, onFollowLinks,
    onLine: (r: BoqRow, line: 'B' | 'C') => patchRow(r.key, { line }),
    onEdit: (r: BoqRow) => setEditing({ row: r, isNew: false }),
    onRemove: removeRow,
  };

  return (
    <>
      <header className="ed-head">
        <div className="wrap ed-bar">
          <div className="ed-title">
            <h1>
              <Link href="/boqs" className="btn small ghost" aria-label="Back to BOQ list"
                onClick={(e) => {
                  if (savedAt.current !== dirty.current) {
                    e.preventDefault();
                    void doSave().then((ok) => { if (ok) router.push('/boqs'); });
                  }
                }}>←</Link>
              <span className="mono" style={{ fontSize: 20 }}>{header.boqNo} R{header.revision}</span>
              <span className={`chip ${chipOf(BOQ_STATUS, header.status)}`}>{labelOf(BOQ_STATUS, header.status)}</span>
            </h1>
            <small>
              {project} · {header.clientName ?? 'No client'}{header.ownerName ? ` · ${header.ownerName}` : ''}
              {' · '}<span className={`savestate${save.kind === 'dirty' || save.kind === 'saving' ? ' off' : ''}${save.kind === 'error' || save.kind === 'stale' ? ' err' : ''}`} aria-live="polite">{readOnly ? 'Read only' : save.text}</span>
              {save.kind === 'stale' && <> · <button className="linkbtn" onClick={() => location.reload()}>Reload</button></>}
            </small>
          </div>
          <label className="f" style={{ flex: '1 1 260px', maxWidth: 420 }}>
            <span className="lbl">Title</span>
            <input value={settings.title} onChange={(e) => patchSettings({ title: e.target.value })} placeholder="e.g. VRF system, floors 1-4" disabled={readOnly} maxLength={300} />
          </label>
        </div>
        <nav className="tabs" aria-label="BOQ steps"><div className="wrap" role="tablist">
          <button role="tab" aria-selected={tab === 'imported'} onClick={() => setTab('imported')}><span className="tag">A</span>Equipment · {brand?.name}<span className="cnt">{impUsed.length}</span></button>
          <button role="tab" aria-selected={tab === 'local'} onClick={() => setTab('local')}><span className="tag">B · C</span>Local &amp; installation<span className="cnt">{locUsed.length}</span></button>
          <button role="tab" aria-selected={tab === 'summary'} onClick={() => setTab('summary')}>Offer summary</button>
        </div></nav>
      </header>

      <main className="wrap ed-main" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {perms.readOnlyReason && (
          <div className="lockbar">
            <span>{perms.readOnlyReason}</span>
            {perms.canRevise && <button className="btn small" onClick={newRevision}>Create revision R{header.latestRevision + 1}</button>}
          </div>
        )}

        <SendLog key={pollKey} boqId={header.id} initial={emails} pollKey={pollKey} />
        <RepliesPanel replies={replies} currentRevision={header.revision} />

        {tab === 'imported' && (
          <section className="panel" aria-label="Equipment (line A)">
            <div className="phead">
              <div className="brandpick" role="group" aria-label="Brand">
                <span className="lbl">Brand · totals are imported items only</span>
                <div className="pills">
                  {brands.map((b) => {
                    const bt = calc.brandTotals.get(b.id);
                    return (
                      <button key={b.id} type="button" className="pill" aria-pressed={b.id === settings.selectedBrandId} disabled={readOnly && b.id !== settings.selectedBrandId}
                        onClick={() => patchSettings({ selectedBrandId: b.id })}>
                        <span className="pn">{b.name}</span>
                        <span className="pt">Tk {bt ? fmt0(bt.importedBdt) : 0}</span>
                        <span className="pc">{bt?.items ? `${bt.items} item${bt.items > 1 ? 's' : ''}` : 'no quantities'}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <PricingPop
                summary={`${settings.exchangeRate} Tk/$${perms.canSeeCost ? ` · profit ${settings.impProfitPct}% · disc ${settings.impDiscountPct}%` : ''}`}
                fields={[
                  { label: 'Tk per USD', value: settings.exchangeRate, onChange: (v) => patchSettings({ exchangeRate: v }), disabled: readOnly },
                  ...(perms.canSeeCost ? [
                    { label: 'Profit %', value: settings.impProfitPct, onChange: (v: string) => patchSettings({ impProfitPct: v }), disabled: readOnly || !perms.canGiveDiscount },
                    { label: 'Discount %', value: settings.impDiscountPct, onChange: (v: string) => patchSettings({ impDiscountPct: v }), disabled: readOnly || !perms.canGiveDiscount },
                  ] : []),
                ]}
                hint="Rate USD = Cost USD × (1 + profit %) × (1 − discount %). Amount Tk = Rate USD × Tk per USD × Qty. These are the defaults; give one product its own profit or discount from its edit (✎) button."
              />
            </div>
            <Tools view={impView} setView={setImpView} used={impUsed.length} all={impAll.length} q={impQ} setQ={setImpQ}
              listLabel="Price list" placeholder="Search model, capacity, type" onAdd={readOnly ? undefined : () => addItem('imp')} />
            <p className="notice">
              <span>{brand?.priceListName}</span>
              {noPriceUsed.some((r) => r.line === 'A') && <span className="warn">Some items in this BOQ have no cost yet, so their rate is 0</span>}
            </p>
            <ItemsTable kind="imp" rows={impShown} view={impView} query={impQ} onGoList={() => setImpView('list')} {...tableProps} />
            <div className="pfoot">
              <span />
              <div className="sums">
                {perms.canSeeCost && <>
                  <div><span className="lbl">Cost Tk</span><b>{fmt(impCost)}</b></div>
                  <div><span className="lbl">Profit Tk</span><b>{fmt(T.aBdt.minus(impCost))}</b></div>
                  <div><span className="lbl">Discount Tk</span><b className="disc">{fmt(impDisc)}</b></div>
                </>}
                <div className="tot"><span className="lbl">Line A total Tk</span><b>{fmt(T.aBdt)}</b></div>
              </div>
            </div>
          </section>
        )}

        {tab === 'local' && (
          <section className="panel" aria-label="Local items and installation (lines B and C)">
            <div className="phead">
              <p className="shared"><b>Shared by all brands.</b> Choose line B (VRF installation and local items) or C (ventilation) per row from the Line column or its edit button.</p>
              {perms.canSeeCost && (
                <PricingPop
                  summary={`profit ${settings.locProfitPct}% · disc ${settings.locDiscountPct}%`}
                  fields={[
                    { label: 'Profit %', value: settings.locProfitPct, onChange: (v) => patchSettings({ locProfitPct: v }), disabled: readOnly || !perms.canGiveDiscount },
                    { label: 'Discount %', value: settings.locDiscountPct, onChange: (v) => patchSettings({ locDiscountPct: v }), disabled: readOnly || !perms.canGiveDiscount },
                  ]}
                  hint="Rate Tk = Cost Tk × (1 + profit %) × (1 − discount %). Pipe insulation quantity follows the matching pipe sizes until you type your own."
                />
              )}
            </div>
            <Tools view={locView} setView={setLocView} used={locUsed.length} all={locAll.length} q={locQ} setQ={setLocQ}
              listLabel="Full list" placeholder="Search pipe size, duct, insulation" onAdd={readOnly ? undefined : () => addItem('loc')} />
            <ItemsTable kind="loc" rows={locShown} view={locView} query={locQ} onGoList={() => setLocView('list')} {...tableProps} />
            <div className="pfoot">
              <span />
              <div className="sums">
                {perms.canSeeCost && <>
                  <div><span className="lbl">Cost Tk</span><b>{fmt(locCost)}</b></div>
                  <div><span className="lbl">Profit Tk</span><b>{fmt(T.bBdt.plus(T.cBdt).minus(locCost))}</b></div>
                  <div><span className="lbl">Discount Tk</span><b className="disc">{fmt(locDisc)}</b></div>
                </>}
                <div className="tot"><span className="lbl">Line B Tk</span><b>{fmt(T.bBdt)}</b></div>
                <div className="tot"><span className="lbl">Line C Tk</span><b>{fmt(T.cBdt)}</b></div>
              </div>
            </div>
          </section>
        )}

        {tab === 'summary' && (
          <SummaryPanel settings={settings} totals={T} project={project} readOnly={readOnly} showCost={perms.canSeeCost} onChange={patchSettings} />
        )}
      </main>

      <div ref={dock} className={`dock${dockOpen ? ' open' : ''}`} aria-label="Totals and export">
        <div className="wrap dock-in">
          <div className="dk-lines" id="dkLines">
            <div><span className="k">A · Imported {brand?.name}</span><b>{fmt(T.aBdt)}</b><small>$ {fmt(T.aUsd)}</small></div>
            <div><span className="k">B · Local &amp; installation</span><b>{fmt(T.bBdt)}</b></div>
            <div><span className="k">C · Ventilation</span><b>{fmt(T.cBdt)}</b></div>
            <div><span className="k">D + E · AIT &amp; VAT</span>
              <b>{fmt((usdOffer ? T.usdOfferAitBdt.plus(T.usdOfferVatBdt) : T.aitBdt.plus(T.vatBdt)))}{settings.addTaxToTotal ? '' : ' (client)'}</b></div>
          </div>
          <button className="dk-toggle" type="button" aria-expanded={dockOpen} aria-controls="dkLines" onClick={() => setDockOpen((o) => !o)}>Totals {dockOpen ? '▾' : '▴'}</button>
          <div className="dk-gt">
            <span className="k">{usdOffer ? 'USD offer · Taka part' : 'Grand total Tk'}</span>
            <b aria-live="polite">{fmt(usdOffer ? T.usdOfferTakaTotal : T.grandTotalBdt)}</b>
            {usdOffer && <small>+ $ {fmt(T.aUsd)}</small>}
          </div>
          <div className="dk-act">
            {perms.canExport && <>
              <div className="xopt" role="radiogroup" aria-label="Excel currency">
                {(['BDT', 'USD', 'BOTH'] as const).map((c) => (
                  <label key={c}><input type="radio" name="expCur" value={c} checked={exportChoice === c} onChange={() => setExportChoice(c)} /> {c === 'BOTH' ? 'Both' : c}</label>
                ))}
              </div>
              <ExportButton busy={exporting} choice={exportChoice} canCosting={perms.canExportCosting} onExport={runExport} />
            </>}
            {canMail && header.clientId && (
              <Link className="btn" href={`/inbox/new?boq=${header.id}`}>Message client</Link>
            )}
            {perms.canSend && (
              <button className="btn send" type="button" onClick={() => setSendOpen(true)} disabled={save.kind === 'stale'}>
                Send BOQ
              </button>
            )}
          </div>
        </div>
      </div>

      {editing && (
        <ItemDrawer
          row={editing.row} isNew={editing.isNew}
          catalog={editing.row.productId ? catalogByProduct.get(editing.row.productId) : undefined}
          settings={calcSettings} canGiveDiscount={perms.canGiveDiscount} groups={groups} types={types}
          onSave={saveDrawer} onRemove={removeRow} onClose={() => setEditing(null)}
        />
      )}
      {sendOpen && (
        <SendDialog
          boqId={header.id} flush={doSave} onClose={() => setSendOpen(false)}
          onQueued={(subject) => {
            setSendOpen(false);
            setPollKey((k) => k + 1);
            toast.show(`Sending “${subject}”. This revision is now locked.`, undefined, 8000);
            router.refresh();
          }}
        />
      )}
      {toast.node}
    </>
  );
}

function Tools(p: { view: 'boq' | 'list'; setView: (v: 'boq' | 'list') => void; used: number; all: number; q: string; setQ: (q: string) => void; listLabel: string; placeholder: string; onAdd?: () => void }) {
  return (
    <div className="ptools">
      <div className="seg" role="group" aria-label="Show">
        <button type="button" aria-pressed={p.view === 'boq'} onClick={() => p.setView('boq')}>In this BOQ <span className="n">{p.used}</span></button>
        <button type="button" aria-pressed={p.view === 'list'} onClick={() => p.setView('list')}>{p.listLabel} <span className="n">{p.all}</span></button>
      </div>
      <label className="search"><span className="sr">Search</span><input type="search" value={p.q} onChange={(e) => p.setQ(e.target.value)} placeholder={p.placeholder} /></label>
      {p.onAdd && <button className="btn add" type="button" onClick={p.onAdd}>+ Add item</button>}
    </div>
  );
}

function PricingPop({ summary, fields, hint }: { summary: string; fields: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean }[]; hint: string }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, useCallback(() => setOpen(false), []));
  return (
    <div className="pricing" ref={ref}>
      <button className="btn" type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>Pricing <span className="psum">{summary}</span> ▾</button>
      {open && (
        <div className="pop" role="group" aria-label="Pricing">
          <div className={fields.length === 3 ? 'row3' : 'row2'}>
            {fields.map((f) => (
              <label key={f.label} className="f"><span className="lbl">{f.label}</span>
                <input inputMode="decimal" value={f.value} disabled={f.disabled} onChange={(e) => { const v = numInput(e.target.value); if (v !== null) f.onChange(v); }} />
              </label>
            ))}
          </div>
          <p className="hint">{hint}</p>
        </div>
      )}
    </div>
  );
}

function ExportButton({ busy, choice, canCosting, onExport }: { busy: boolean; choice: ExportChoice; canCosting: boolean; onExport: (withCosting: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, useCallback(() => setOpen(false), []));
  return (
    <div className="split" ref={ref}>
      <button className="btn primary" type="button" disabled={busy} onClick={() => onExport(false)}>
        {busy ? 'Making file…' : <>Export · {choice === 'BOTH' ? 'USD + BDT' : choice}</>}
      </button>
      {canCosting && (<>
        <button className="btn primary" type="button" aria-haspopup="menu" aria-expanded={open} aria-label="More export options" onClick={() => setOpen((o) => !o)}>▾</button>
        {open && (
          <div className="menu-list" role="menu">
            <button className="mi" role="menuitem" type="button" disabled={busy} onClick={() => { setOpen(false); onExport(true); }}>
              Export with internal costing<small>Adds a costing sheet. For internal use only, never sent.</small>
            </button>
          </div>
        )}
      </>)}
    </div>
  );
}
