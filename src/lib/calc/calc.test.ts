import { describe, expect, it } from 'vitest';
import { calculate, dec, fmt, taxes, type CalcRow, type CalcSettings } from './index';
import { inWordsTaka, inWordsUsd } from './words';

const S: CalcSettings = {
  selectedBrandId: 1, exchangeRate: 122, impProfitPct: 10, impDiscountPct: 0, locProfitPct: 10, locDiscountPct: 0,
  aitPct: 5, vatPct: 7.5, taxMethod: 'gross', taxBaseA: true, taxBaseB: true, taxBaseC: true, addTaxToTotal: false,
};
const row = (p: Partial<CalcRow> & Pick<CalcRow, 'key'>): CalcRow => ({
  line: 'A', brandId: 1, productId: null, cost: 0, qty: 0, qtyFollowsLinks: false, profitPct: null, discountPct: null,
  defaultProfitZero: false, ...p,
});

describe('line rates', () => {
  it('imported line: rate USD, rate Tk rounded before multiplying by qty', () => {
    const r = calculate([row({ key: 'a', cost: 7200, qty: 2 })], S).items.get('a')!;
    expect(r.rate.toFixed(2)).toBe('7920.00');
    expect(r.rateBdt.toFixed(2)).toBe('966240.00');
    expect(r.amountBdt.toFixed(2)).toBe('1932480.00');
    expect(r.amountUsd!.toFixed(2)).toBe('15840.00');
  });

  it('rounds twice: after profit and after discount (half up)', () => {
    const r = calculate([row({ key: 'a', cost: '33.33', qty: 1, profitPct: '7.5', discountPct: '2.5' })], S).items.get('a')!;
    expect(r.listRate.toFixed(2)).toBe('35.83');   // 33.33 × 1.075 = 35.82975
    expect(r.rate.toFixed(2)).toBe('34.93');       // 35.83 × 0.975 = 34.93425
  });

  it('freight lines default to 0% profit unless set', () => {
    const r = calculate([row({ key: 'f', cost: 1000, qty: 1, defaultProfitZero: true })], S).items.get('f')!;
    expect(r.rate.toFixed(2)).toBe('1000.00');
    const r2 = calculate([row({ key: 'f', cost: 1000, qty: 1, defaultProfitZero: true, profitPct: 5 })], S).items.get('f')!;
    expect(r2.rate.toFixed(2)).toBe('1050.00');
  });

  it('no price counts as 0 and is flagged', () => {
    const r = calculate([row({ key: 'x', cost: null, qty: 3 })], S).items.get('x')!;
    expect(r.missingPrice).toBe(true);
    expect(r.amountBdt.toNumber()).toBe(0);
  });

  it('local line uses local defaults and stays in Tk', () => {
    const r = calculate([row({ key: 'l', line: 'B', brandId: null, cost: 70, qty: 250 })], S).items.get('l')!;
    expect(r.rate.toFixed(2)).toBe('77.00');
    expect(r.amountBdt.toFixed(2)).toBe('19250.00');
    expect(r.amountUsd).toBeNull();
  });
});

describe('pipe insulation follows linked pipe quantities', () => {
  it('sums raw qty of the linked products', () => {
    const rows = [
      row({ key: 'p1', line: 'B', brandId: null, productId: 'pipe38', cost: 105, qty: 300 }),
      row({ key: 'p2', line: 'B', brandId: null, productId: 'coil38', cost: 200, qty: 50 }),
      row({ key: 'i', line: 'B', brandId: null, productId: 'ins38', cost: 35, qty: 0, qtyFollowsLinks: true, linkSources: ['pipe38', 'coil38'] }),
    ];
    expect(calculate(rows, S).items.get('i')!.qty.toNumber()).toBe(350);
  });
});

describe('offer totals', () => {
  const rows = [
    row({ key: 'lg', brandId: 1, cost: 7200, qty: 2 }),
    row({ key: 'dk', brandId: 2, cost: 9000, qty: 2 }),   // other brand: kept for comparison, not in offer
    row({ key: 'b', line: 'B', brandId: null, cost: 70, qty: 250 }),
    row({ key: 'c', line: 'C', brandId: null, cost: 1200, qty: 20 }),
  ];
  const T = calculate(rows, S);

  it('only the selected brand counts in line A', () => {
    expect(T.totals.aBdt.toFixed(2)).toBe('1932480.00');
    expect(T.brandTotals.get(2)!.importedBdt.toFixed(2)).toBe('2415600.00');
  });

  it('grand total excludes taxes when they are provided by the client', () => {
    expect(T.totals.grandTotalBdt.toFixed(2)).toBe((1932480 + 19250 + 26400).toFixed(2));
  });

  it('gross-up taxes', () => {
    const t = taxes(dec(1_000_000), 5, 7.5, 'gross');
    expect(t.ait.toDecimalPlaces(2).toFixed(2)).toBe('52631.58');
    expect(t.vat.toDecimalPlaces(2).toFixed(2)).toBe('85348.51');
  });

  it('USD offer taxes use B and C only', () => {
    const base = 19250 + 26400;
    expect(T.totals.usdOfferBase.toNumber()).toBe(base);
    expect(T.totals.usdOfferTakaTotal.toFixed(2)).toBe(base.toFixed(2));
    const withTax = calculate(rows, { ...S, addTaxToTotal: true }).totals;
    expect(withTax.usdOfferTakaTotal.toNumber()).toBeCloseTo(base + withTax.usdOfferAitBdt.toNumber() + withTax.usdOfferVatBdt.toNumber(), 1);
  });

  it('profit = selling − cost of the lines in the offer', () => {
    const cost = 7200 * 2 * 122 + 70 * 250 + 1200 * 20;
    expect(T.totals.profitBdt.toFixed(2)).toBe((1932480 + 19250 + 26400 - cost).toFixed(2));
  });
});

describe('formatting and words', () => {
  it('formats with half-up rounding', () => {
    expect(fmt('1.005')).toBe('1.01');
    expect(fmt(1234567.5)).toBe('1,234,567.50');
  });
  it('Taka in crore / lakh', () => {
    expect(inWordsTaka(12345678.5)).toBe('Taka One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Paisa Fifty Only');
  });
  it('USD in thousands', () => {
    expect(inWordsUsd(15840)).toBe('US Dollar Fifteen Thousand Eight Hundred Forty Only');
  });
});
