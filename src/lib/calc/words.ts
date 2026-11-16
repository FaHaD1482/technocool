/** Amounts in words, as printed on the offer. Taka uses crore / lakh; USD uses million / billion. */
import { Dec, type Dec as DecT } from './index';

const ONES = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

/** Indexes are always reduced to 0–19 below; the fallback keeps the return type a plain string. */
const digit = (n: number): string => ONES[n] ?? '';

const w2 = (n: number): string => (n < 20 ? digit(n) : (TENS[Math.floor(n / 10)] ?? '') + (n % 10 ? ' ' + digit(n % 10) : ''));
const w3 = (n: number) => {
  const h = Math.floor(n / 100), r = n % 100;
  return [h ? digit(h) + ' Hundred' : '', r ? w2(r) : ''].filter(Boolean).join(' ');
};

function wBD(n: number): string {
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 1e7); n %= 1e7;
  if (crore) parts.push(wBD(crore) + ' Crore');
  const lakh = Math.floor(n / 1e5); n %= 1e5; if (lakh) parts.push(w2(lakh) + ' Lakh');
  const th = Math.floor(n / 1000); n %= 1000; if (th) parts.push(w2(th) + ' Thousand');
  const h = Math.floor(n / 100); n %= 100; if (h) parts.push(digit(h) + ' Hundred');
  if (n) parts.push(w2(n));
  return parts.join(' ');
}

function wIntl(n: number): string {
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  for (const [d, w] of [[1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand']] as const) {
    const k = Math.floor(n / d);
    if (k) { parts.push(w3(k) + ' ' + w); n %= d; }
  }
  if (n) parts.push(w3(n));
  return parts.join(' ');
}

function split(x: DecT | number) {
  const cents = new Dec(x).abs().mul(100).toDecimalPlaces(0).toNumber();
  return { whole: Math.floor(cents / 100), frac: cents % 100 };
}

export function inWordsTaka(x: DecT | number): string {
  const { whole, frac } = split(x);
  return 'Taka ' + wBD(whole) + (frac ? ' and Paisa ' + w2(frac) : '') + ' Only';
}

export function inWordsUsd(x: DecT | number): string {
  const { whole, frac } = split(x);
  return 'US Dollar ' + wIntl(whole) + (frac ? ' and Cents ' + w2(frac) : '') + ' Only';
}
