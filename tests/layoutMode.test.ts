import { describe, expect, it } from 'vitest';
import {
  cycleLayoutPreference,
  effectiveLayoutMode,
  layoutModeForViewport,
  normalizeLayoutPreference,
  resolveLayoutMode,
} from '../src/layoutMode';

describe('layout mode', () => {
  it('normalizes saved preferences and safely falls back to auto', () => {
    expect(normalizeLayoutPreference('auto')).toBe('auto');
    expect(normalizeLayoutPreference('desktop')).toBe('desktop');
    expect(normalizeLayoutPreference('tablet')).toBe('tablet');
    expect(normalizeLayoutPreference('mobile')).toBe('mobile');
    expect(normalizeLayoutPreference('invalid')).toBe('auto');
    expect(normalizeLayoutPreference(null)).toBe('auto');
  });

  it('selects mobile, tablet, and desktop at the documented boundaries', () => {
    expect(layoutModeForViewport(320)).toBe('mobile');
    expect(layoutModeForViewport(700)).toBe('mobile');
    expect(layoutModeForViewport(701)).toBe('tablet');
    expect(layoutModeForViewport(1024)).toBe('tablet');
    expect(layoutModeForViewport(1025)).toBe('desktop');
    expect(layoutModeForViewport(1440)).toBe('desktop');
  });

  it('derives the effective layout from the viewport only in auto', () => {
    expect(effectiveLayoutMode('auto', 390)).toBe('mobile');
    expect(effectiveLayoutMode('auto', 820)).toBe('tablet');
    expect(effectiveLayoutMode('auto', 1440)).toBe('desktop');
    expect(effectiveLayoutMode('desktop', 390)).toBe('desktop');
    expect(effectiveLayoutMode('tablet', 390)).toBe('tablet');
    expect(effectiveLayoutMode('mobile', 1440)).toBe('mobile');
    expect(resolveLayoutMode('invalid', 820)).toEqual({ preference: 'auto', effective: 'tablet' });
  });

  it('cycles through the complete preference sequence', () => {
    expect(cycleLayoutPreference('auto')).toBe('desktop');
    expect(cycleLayoutPreference('desktop')).toBe('tablet');
    expect(cycleLayoutPreference('tablet')).toBe('mobile');
    expect(cycleLayoutPreference('mobile')).toBe('auto');
  });
});
