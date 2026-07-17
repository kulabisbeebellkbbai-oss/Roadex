import { describe, expect, it } from 'vitest';
import {
  activeSession,
  navItems,
  portalTargets,
  safeguards,
  sessionSummaries,
} from '../src/roadexModel';

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

  it('surfaces the Codex server session contract for the active workspace', () => {
    expect(activeSession).toMatchObject({
      lifecycle: 'ready',
      runnerMode: 'codex',
      transport: 'sse',
      deviceBridge: 'disabled',
    });
    expect(activeSession.gates.some((gate) => gate.id === 'device-bridge')).toBe(true);
  });
});
