import { describe, expect, it } from 'vitest';
import { likePattern, pageCount, pageHref, pageNumbers, parsePage } from '@/lib/paging';

describe('parsePage', () => {
  it('defaults to page 1 for missing, junk, zero or negative input', () => {
    for (const raw of [undefined, '', 'abc', '0', '-5', '1.9e999']) expect(parsePage(raw).page).toBe(1);
  });
  it('computes the offset from the page and size', () => {
    expect(parsePage('3', 25)).toEqual({ page: 3, size: 25, offset: 50 });
  });
  it('caps absurd page numbers', () => {
    expect(parsePage('99999999').page).toBe(10_000);
  });
  it('takes the first value of a repeated parameter', () => {
    expect(parsePage(['2', '7']).page).toBe(2);
  });
});

describe('pageCount', () => {
  it('is at least 1 and rounds up', () => {
    expect(pageCount(0, 50)).toBe(1);
    expect(pageCount(50, 50)).toBe(1);
    expect(pageCount(51, 50)).toBe(2);
  });
});

describe('pageHref', () => {
  it('keeps filters, drops empty values and page 1', () => {
    expect(pageHref('/boqs', { status: 'sent', q: '' }, 1)).toBe('/boqs?status=sent');
    expect(pageHref('/boqs', { status: undefined, q: 'a b' }, 3)).toBe('/boqs?q=a+b&page=3');
    expect(pageHref('/inbox', {}, 1)).toBe('/inbox');
  });
});

describe('pageNumbers', () => {
  it('lists every page when there are few', () => {
    expect(pageNumbers(2, 3)).toEqual([1, 2, 3]);
  });
  it('shows first, last, neighbours and gaps', () => {
    expect(pageNumbers(10, 20)).toEqual([1, null, 9, 10, 11, null, 20]);
    expect(pageNumbers(1, 20)).toEqual([1, 2, null, 20]);
    expect(pageNumbers(20, 20)).toEqual([1, null, 19, 20]);
  });
});

describe('likePattern', () => {
  it('escapes LIKE wildcards so they match literally', () => {
    expect(likePattern('50%_a\\b')).toBe('%50\\%\\_a\\\\b%');
  });
});
