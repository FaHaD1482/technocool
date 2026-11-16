import { describe, expect, it } from 'vitest';
import { safeInternalPath } from './safe-path';

describe('safeInternalPath', () => {
  it('keeps same-site paths', () => {
    expect(safeInternalPath('/boqs')).toBe('/boqs');
    expect(safeInternalPath('/inbox/abc?filter=unread#top')).toBe('/inbox/abc?filter=unread#top');
  });
  it('rejects other sites, including the backslash trick', () => {
    expect(safeInternalPath('https://evil.example')).toBe('/boqs');
    expect(safeInternalPath('//evil.example')).toBe('/boqs');
    expect(safeInternalPath('/\\evil.example')).toBe('/boqs');
    expect(safeInternalPath('/%2fevil.example')).toBe('/boqs');
    expect(safeInternalPath('javascript:alert(1)')).toBe('/boqs');
    expect(safeInternalPath(null)).toBe('/boqs');
  });
  it('uses the caller fallback', () => {
    expect(safeInternalPath('//evil.example', '/')).toBe('/');
  });
});
