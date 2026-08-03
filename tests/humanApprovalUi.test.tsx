import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApprovalWaitCard } from '../src/components/ApprovalWaitCard';
import {
  approvalWaitBodyCopy,
  approvalWaitStatusCopy,
  safeApprovalConsolePath,
} from '../src/components/approvalWait';
import {
  approvalProjectionForSession,
  isApprovalWaitTransitionEvent,
} from '../src/hooks/useRoadexSession';
import { createLatestRefreshSequence } from '../src/hooks/latestRefreshSequence';
import type { RoadexSession, StreamEvent } from '../src/shared/sessionContracts';
import type { WaitingApprovalSummary } from '../src/shared/approvalWorkflowContracts';

const baseWait: WaitingApprovalSummary = {
  waitId: 'wait-ui-1',
  approvalRef: 'approval-REF-2026-08-02',
  subject: 'Publish the reviewed protected route',
  consoleSurface: 'admin',
  consolePath: '/Overseer/admin',
  state: 'pending',
  updatedAt: '2026-08-02T20:00:00.000Z',
};

describe('human approval UI', () => {
  it('renders an accessible admin wait before continuation without mutating approval', () => {
    const markup = renderToStaticMarkup(<ApprovalWaitCard wait={baseWait} />);

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-label="Human approval required"');
    expect(markup).toContain('Human approval required');
    expect(markup).toContain('This thread is safely paused.');
    expect(markup).toContain('Approve Publish the reviewed protected route in the Admin Console.');
    expect(markup).toContain('Roadex will continue automatically after approval is verified.');
    expect(markup).toContain('approval-REF-2026-08-02');
    expect(markup).toContain('href="/Overseer/admin"');
    expect(markup).toContain('Open Admin Console');
    expect(markup.match(/href="([^"]+)"/)?.[1]).not.toMatch(/approve|decision|mutation/i);
  });

  it('renders the exact overview console label and omits absent navigation', () => {
    const markup = renderToStaticMarkup(<ApprovalWaitCard wait={{
      ...baseWait,
      consoleSurface: 'overview',
      consolePath: undefined,
    }} />);

    expect(markup).toContain('Overview Console');
    expect(markup).not.toContain('<a');
  });

  it('rejects absolute, cross-surface, traversal, query, and fragment console paths', () => {
    expect(safeApprovalConsolePath('admin', '/Overseer/admin')).toBe('/Overseer/admin');
    expect(safeApprovalConsolePath('overview', '/Overseer/overview')).toBe('/Overseer/overview');
    expect(safeApprovalConsolePath('admin', 'https://example.test/Overseer/admin')).toBeUndefined();
    expect(safeApprovalConsolePath('admin', '//example.test/Overseer/admin')).toBeUndefined();
    expect(safeApprovalConsolePath('admin', '/Overseer/overview')).toBeUndefined();
    expect(safeApprovalConsolePath('overview', '/Overseer/../admin')).toBeUndefined();
    expect(safeApprovalConsolePath('admin', '/Overseer/admin?approve=1')).toBeUndefined();
    expect(safeApprovalConsolePath('overview', '/Overseer/overview#approval')).toBeUndefined();
  });

  it.each([
    ['pending', 'Waiting for human approval.'],
    ['verification-delayed', 'Approval verification is delayed. Roadex remains safely paused.'],
    ['security-failure', 'Approval verification failed security checks. Manual review is required.'],
    ['approved-resume-queued', 'Approval verified. Continuation is queued for runner capacity.'],
    ['resume-dispatching', 'Approval verified. Roadex is dispatching the continuation.'],
    ['resume-reconciliation-required', 'Continuation status is uncertain. Reconciliation is required.'],
  ] as const)('provides non-color-only copy for %s', (state, expected) => {
    expect(approvalWaitStatusCopy(state)).toBe(expected);
    expect(renderToStaticMarkup(<ApprovalWaitCard wait={{ ...baseWait, state }} />)).toContain(expected);
  });

  it.each([
    [
      'verification-delayed',
      'Approval verification is delayed in the Admin Console. This thread remains safely paused.',
      'Roadex is retrying verification; do not submit a second approval.',
    ],
    [
      'approved-resume-queued',
      'Approval was granted in the Admin Console.',
      'Roadex is waiting for runner capacity before continuing.',
    ],
    [
      'resume-dispatching',
      'Approval was granted in the Admin Console.',
      'The continuation is being delivered to the managed thread.',
    ],
    [
      'security-failure',
      'Approval security verification failed for Publish the reviewed protected route.',
      'Roadex remains safely paused for manual review in the Admin Console.',
    ],
    [
      'resume-reconciliation-required',
      'Approval remains recorded in the Admin Console.',
      'An operator must verify whether the exact continuation was accepted before Roadex can proceed.',
    ],
  ] as const)('renders state-specific body copy for %s', (state, primary, secondary) => {
    const wait = { ...baseWait, state };
    expect(approvalWaitBodyCopy(wait)).toEqual({ primary, secondary });

    const markup = renderToStaticMarkup(<ApprovalWaitCard wait={wait} />);
    expect(markup).toContain(primary);
    expect(markup).toContain(secondary);
    expect(markup).not.toContain('Approve Publish the reviewed protected route');
    expect(markup).not.toContain('Roadex will continue automatically after approval is verified.');
  });

  it('projects blocking state only from the selected server session', () => {
    const waiting = approvalProjectionForSession(session({ waitingApproval: baseWait }));
    expect(waiting.approvalWait).toEqual(baseWait);
    expect(waiting.approvalComposerBlocked).toBe(true);

    for (const lifecycle of ['ready', 'blocked', 'closed'] as const) {
      expect(approvalProjectionForSession(session({ lifecycle })).approvalComposerBlocked).toBe(false);
    }
  });

  it('refreshes server state for approval transition events without reading outcome or URLs from SSE', () => {
    expect(isApprovalWaitTransitionEvent(event('Roadex is waiting for human approval in Admin Console.'))).toBe(true);
    expect(isApprovalWaitTransitionEvent(event('Roadex human approval result: resumed'))).toBe(true);
    expect(isApprovalWaitTransitionEvent(event('https://evil.test/approve?decision=approved'))).toBe(false);
    expect(isApprovalWaitTransitionEvent(event('ordinary transcript text'))).toBe(false);
  });

  it('prevents an older approval refresh from overwriting the latest terminal projection', () => {
    const sequence = createLatestRefreshSequence();
    const olderPending = sequence.begin();
    const newerTerminal = sequence.begin();
    let projectedWait: WaitingApprovalSummary | undefined = baseWait;

    expect(sequence.applyIfLatest(newerTerminal, () => {
      projectedWait = undefined;
    })).toBe(true);
    expect(sequence.applyIfLatest(olderPending, () => {
      projectedWait = baseWait;
    })).toBe(false);
    expect(projectedWait).toBeUndefined();
  });
});

function session(overrides: Partial<RoadexSession> = {}): RoadexSession {
  return {
    id: 'session-ui',
    userId: 'owner',
    workspace: { id: 'roadex', name: 'Roadex', root: '/srv/roadex' },
    lifecycle: 'ready',
    runnerMode: 'codex',
    transport: 'sse',
    deviceBridge: 'disabled',
    gates: [],
    createdAt: '2026-08-02T20:00:00.000Z',
    updatedAt: '2026-08-02T20:00:00.000Z',
    ...overrides,
  };
}

function event(message: string): StreamEvent {
  return {
    id: `event-${message.length}`,
    sessionId: 'session-ui',
    kind: 'system',
    message,
    at: '2026-08-02T20:00:00.000Z',
  };
}
