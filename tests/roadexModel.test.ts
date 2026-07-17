import { describe, expect, it } from 'vitest';
import { navItems, portalTargets, safeguards, sessionSummaries } from '../src/roadexModel';

describe('roadex portal model', () => {
  it('keeps security and deferred device access visible in the first app milestone', () => {
    expect(navItems.map((item) => item.label)).toContain('Security');
    expect(navItems.map((item) => item.label)).toContain('Devices');
    expect(safeguards).toContain('Per-user workspace isolation');
    expect(sessionSummaries.some((session) => session.signal === 'Deferred')).toBe(true);
    expect(portalTargets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'Desktop, tablet, mobile' }),
        expect.objectContaining({ value: 'Deferred until review' }),
      ]),
    );
  });
});
