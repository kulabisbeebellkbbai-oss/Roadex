export type LayoutMode = 'desktop' | 'mobile';

export function resolveLayoutMode(stored: string | null, compactViewport: boolean): LayoutMode {
  if (stored === 'desktop' || stored === 'mobile') return stored;
  return compactViewport ? 'mobile' : 'desktop';
}

export function toggleLayoutMode(mode: LayoutMode): LayoutMode {
  return mode === 'desktop' ? 'mobile' : 'desktop';
}
