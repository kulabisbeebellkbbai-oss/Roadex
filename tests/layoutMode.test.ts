import { describe, expect, it } from 'vitest';
import { resolveLayoutMode, toggleLayoutMode } from '../src/layoutMode';

describe('layout mode', () => {
  it('uses a saved valid preference before viewport defaults', () => {
    expect(resolveLayoutMode('desktop', true)).toBe('desktop');
    expect(resolveLayoutMode('mobile', false)).toBe('mobile');
  });

  it('falls back to the physical viewport and toggles modes', () => {
    expect(resolveLayoutMode(null, true)).toBe('mobile');
    expect(resolveLayoutMode('invalid', false)).toBe('desktop');
    expect(toggleLayoutMode('desktop')).toBe('mobile');
    expect(toggleLayoutMode('mobile')).toBe('desktop');
  });
});
