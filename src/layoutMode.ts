export type EffectiveLayoutMode = 'desktop' | 'tablet' | 'mobile';
export type LayoutPreference = 'auto' | EffectiveLayoutMode;

const LAYOUT_PREFERENCE_CYCLE: LayoutPreference[] = ['auto', 'desktop', 'tablet', 'mobile'];

export function normalizeLayoutPreference(stored: string | null): LayoutPreference {
  return LAYOUT_PREFERENCE_CYCLE.includes(stored as LayoutPreference)
    ? stored as LayoutPreference
    : 'auto';
}

export function layoutModeForViewport(viewportWidth: number): EffectiveLayoutMode {
  if (viewportWidth <= 700) return 'mobile';
  if (viewportWidth <= 1024) return 'tablet';
  return 'desktop';
}

export function effectiveLayoutMode(
  preference: LayoutPreference,
  viewportWidth: number,
): EffectiveLayoutMode {
  return preference === 'auto' ? layoutModeForViewport(viewportWidth) : preference;
}

export function resolveLayoutMode(
  stored: string | null,
  viewportWidth: number,
): { preference: LayoutPreference; effective: EffectiveLayoutMode } {
  const preference = normalizeLayoutPreference(stored);
  return { preference, effective: effectiveLayoutMode(preference, viewportWidth) };
}

export function cycleLayoutPreference(preference: LayoutPreference): LayoutPreference {
  const index = LAYOUT_PREFERENCE_CYCLE.indexOf(preference);
  return LAYOUT_PREFERENCE_CYCLE[(index + 1) % LAYOUT_PREFERENCE_CYCLE.length];
}
