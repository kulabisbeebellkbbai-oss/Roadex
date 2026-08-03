import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RoadexSessionState } from '../src/hooks/useRoadexSession';
import type { WaitingApprovalSummary } from '../src/shared/approvalWorkflowContracts';
import App from '../src/App';

const noop = async () => Promise.resolve();

type MutableRoadexSessionState = RoadexSessionState;

const baseWorkspace = {
  id: 'roadex',
  name: 'Roadex',
  root: '/srv/roadex',
};

const baseSession = {
  id: 'session-active',
  userId: 'owner',
  workspace: baseWorkspace,
  lifecycle: 'ready' as const,
  runnerMode: 'codex' as const,
  transport: 'sse' as const,
  deviceBridge: 'disabled' as const,
  gates: [],
  createdAt: '2026-08-02T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:00.000Z',
};

const baseState: Omit<MutableRoadexSessionState, 'session' | 'approvalWait' | 'approvalComposerBlocked'> = {
  connectionState: 'connected',
  token: undefined,
  user: {
    id: 'owner',
    displayName: 'Owner',
    authMode: 'mock',
    roles: ['user', 'admin', 'security-reviewer'],
  },
  workspaces: [baseWorkspace],
  sessions: [{ ...baseSession, codexThreadId: 'thread-managed' }],
  managedThreads: [{
    id: 'thread-managed',
    label: 'Roadex thread',
    project: baseWorkspace,
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
  }],
  archivedSessions: [],
  deviceBridgePolicy: {
    state: 'disabled',
    approvedFoundation: true,
    operations: ['esp32.flash'],
    requestIntakeEnabled: false,
    descriptorObservationEnabled: false,
    operationsEnabled: false,
    writeEnabled: false,
    reason: 'disabled',
  },
  browserDeviceCapability: {
    transport: 'unavailable',
    identityProbeAvailable: false,
    deviceAccessRequested: false,
  },
  deviceInventoryBindingRefs: [],
  serialVerificationProfiles: [],
  bleVerificationProfiles: [],
  usbDeviceProfiles: [],
  transcript: [],
  auditEvents: [],
  verifiedFirmwareReady: false,
  sendPrompt: noop,
  cancelPrompt: noop,
  closeCurrentSession: noop,
  archiveThread: noop,
  recoverThread: noop,
  reopenArchivedSession: noop,
  openWorkspace: noop,
  createThread: noop,
  selectThread: noop,
  attachManagedThread: noop,
  observeUsbDescriptor: noop,
  verifyEsp32Identity: noop,
  createProbeApproval: noop,
  runControlledProbe: noop,
  confirmControlledProbe: noop,
  loadConfirmedFirmware: noop,
  flashConfirmedFirmware: noop,
  retry: noop,
};

function ensureBrowserWindow(): void {
  if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
    (globalThis as { window: Record<string, unknown> }).window = {
      navigator: {},
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
        clear: () => undefined,
      },
      matchMedia: () => ({
        matches: false,
        media: '',
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => true,
      }),
    };
  }
  const windowLike = globalThis.window as {
    matchMedia: () => { matches: boolean; media: string; onchange: null; addEventListener: () => void; removeEventListener: () => void; addListener: () => void; removeListener: () => void; dispatchEvent: () => boolean };
    localStorage: { getItem: () => string | null; setItem: () => void; removeItem: () => void; clear: () => void };
    navigator: object;
  };
  if (typeof windowLike.matchMedia !== 'function') {
    windowLike.matchMedia = () => ({
      matches: false,
      media: '',
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    });
  }
  if (!windowLike.localStorage) {
    windowLike.localStorage = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
    };
  }
  if (!windowLike.navigator) {
    windowLike.navigator = {};
  }
}

function roadexState(overrides: Partial<MutableRoadexSessionState> = {}): MutableRoadexSessionState {
  return {
    ...baseState,
    session: {
      ...baseSession,
      codexThreadId: 'thread-managed',
      ...(overrides.session ?? {}),
    },
    approvalWait: overrides.approvalWait,
    approvalComposerBlocked: Boolean(overrides.approvalWait),
    ...overrides,
  };
}

function renderAppMarkup(): string {
  ensureBrowserWindow();
  return renderToStaticMarkup(<App />);
}

function promptInputIsDisabled(html: string): boolean {
  const formMatch = html.match(/<form class="prompt-row"[\s\S]*?<\/form>/);
  if (!formMatch) return false;
  const inputMatch = formMatch[0].match(/<input[^>]*>/g)?.find((line) => line.includes('type="text"'));
  return inputMatch ? /disabled/.test(inputMatch) : false;
}

let state: MutableRoadexSessionState = roadexState();

vi.mock('../src/hooks/useRoadexSession', () => ({
  useRoadexSession: () => state,
}));

afterEach(() => {
  state = roadexState();
});

describe('human approval UI card', () => {
  it('renders approval card before transcript with exact pending text and role status', () => {
    const approvalWait: WaitingApprovalSummary = {
      waitId: 'wait-active',
      approvalRef: 'admin.roadex.approval',
      subject: 'provisioning a protected operation',
      consoleSurface: 'admin',
      consolePath: '/Overseer/admin',
      state: 'pending',
      updatedAt: '2026-08-02T00:00:00.000Z',
    };

    state = roadexState({
      session: { ...baseSession, lifecycle: 'paused', waitingApproval: approvalWait },
      approvalWait,
      approvalComposerBlocked: true,
    });

    const html = renderAppMarkup();

    const approvalMarker = html.indexOf('aria-label="Human approval required"');
    const roleMarker = html.indexOf('role="status"', approvalMarker);
    expect(approvalMarker).toBeGreaterThan(-1);
    expect(roleMarker).toBeGreaterThan(approvalMarker);
    expect(html).toContain('aria-label="Conversation history"');
    const transcriptMarker = html.indexOf('aria-label="Conversation history"');
    expect(transcriptMarker).toBeGreaterThan(-1);
    expect(approvalMarker).toBeLessThan(transcriptMarker);
    expect(html).toContain('Human approval required');
    expect(html).toContain('This thread is safely paused.');
    expect(html).toContain('Roadex will continue automatically after approval is verified.');
    expect(html).toContain('Approval reference: admin.roadex.approval');
    expect(html).toContain('Awaiting human approval (Admin Console)');
    expect(promptInputIsDisabled(html)).toBe(true);
    expect(html).toContain('href="/Overseer/admin"');
    expect(html).toContain('Open Admin Console');
  });

  it.each([
    ['absolute URL', 'admin', 'https://example.com/Overseer/admin'],
    ['network-path URL', 'admin', '//example.com/Overseer/admin'],
    ['unapproved relative path', 'admin', '/admin/approvals/admin.roadex.approval'],
    ['admin surface mismatch', 'admin', '/Overseer/overview'],
    ['overview surface mismatch', 'overview', '/Overseer/admin'],
  ] as Array<[string, WaitingApprovalSummary['consoleSurface'], string]>)('does not render an unsafe %s from server projection', (_label, consoleSurface, consolePath) => {
    const approvalWait: WaitingApprovalSummary = {
      waitId: 'wait-danger',
      approvalRef: 'admin.roadex.approval',
      subject: 'provisioning a protected operation',
      consoleSurface,
      consolePath,
      state: 'pending',
      updatedAt: '2026-08-02T00:00:00.000Z',
    };

    state = roadexState({
      session: { ...baseSession, lifecycle: 'paused', waitingApproval: approvalWait },
      approvalWait,
      approvalComposerBlocked: true,
    });

    const html = renderAppMarkup();

    const approvalMarker = html.indexOf('aria-label="Human approval required"');
    const roleMarker = html.indexOf('role="status"', approvalMarker);
    expect(approvalMarker).toBeGreaterThan(-1);
    expect(roleMarker).toBeGreaterThan(approvalMarker);
    expect(html).not.toContain('approval-wait-link');
    expect(html).toContain('This thread is safely paused.');
  });

  it('renders the exact deployment-owned overview-console path', () => {
    const approvalWait: WaitingApprovalSummary = {
      waitId: 'wait-overview',
      approvalRef: 'overview.roadex.approval',
      subject: 'reviewing the Roadex project plan',
      consoleSurface: 'overview',
      consolePath: '/Overseer/overview',
      state: 'pending',
      updatedAt: '2026-08-02T00:00:00.000Z',
    };

    state = roadexState({
      session: { ...baseSession, lifecycle: 'paused', waitingApproval: approvalWait },
      approvalWait,
      approvalComposerBlocked: true,
    });

    const html = renderAppMarkup();

    expect(html).toContain('Approve reviewing the Roadex project plan in the Overview Console.');
    expect(html).toContain('href="/Overseer/overview"');
    expect(html).toContain('Open Overview Console');
  });

  it.each([
    {
      waitState: 'pending',
      consoleSurface: 'admin',
      expected: [
        'This thread is safely paused.',
        'Roadex will continue automatically after approval is verified.',
      ],
    },
    {
      waitState: 'verification-delayed',
      consoleSurface: 'overview',
      expected: [
        'Approval verification is delayed.',
        'Roadex has not rechecked',
        'Roadex will continue automatically after approval is verified.',
      ],
    },
    {
      waitState: 'security-failure',
      consoleSurface: 'admin',
      expected: [
        'Approval could not be validated safely.',
        'Roadex could not verify the approval binding for',
        'This thread remains paused and will not continue automatically.',
      ],
    },
    {
      waitState: 'approved-resume-queued',
      consoleSurface: 'overview',
      expected: [
        'Approval granted - resuming automatically.',
        'Waiting for runner capacity.',
      ],
    },
    {
      waitState: 'resume-dispatching',
      consoleSurface: 'admin',
      expected: [
        'Approval granted - resuming automatically.',
        'Dispatching the continuation for',
      ],
    },
    {
      waitState: 'resume-reconciliation-required',
      consoleSurface: 'overview',
      expected: [
        'Approval granted - resuming automatically.',
        'operator must verify whether the exact continuation was accepted.',
      ],
    },
  ] as Array<{ waitState: WaitingApprovalSummary['state']; consoleSurface: WaitingApprovalSummary['consoleSurface']; expected: string[] }>)('shows state-specific approval copy for %s', ({
    waitState,
    consoleSurface,
    expected,
  }) => {
    const approvalWait: WaitingApprovalSummary = {
      waitId: `wait-${waitState}`,
      approvalRef: `${waitState}.roadex.approval`,
      subject: `${waitState} test subject`,
      consoleSurface,
      consolePath: consoleSurface === 'admin' ? '/Overseer/admin' : '/Overseer/overview',
      state: waitState,
      updatedAt: '2026-08-02T00:00:00.000Z',
    };

    state = roadexState({
      session: { ...baseSession, lifecycle: 'paused', waitingApproval: approvalWait },
      approvalWait,
      approvalComposerBlocked: true,
    });

    const html = renderAppMarkup();
    for (const phrase of expected) {
      expect(html).toContain(phrase);
    }
    expect(promptInputIsDisabled(html)).toBe(true);
    if (waitState === 'security-failure') {
      const card = html.slice(
        html.indexOf('aria-label="Human approval required"'),
        html.indexOf('aria-label="Conversation history"'),
      );
      expect(card.toLowerCase()).not.toContain('retry');
      expect(card.toLowerCase()).not.toContain('request a fresh approval');
    }
    if (waitState === 'resume-dispatching') {
      expect(html.toLowerCase()).not.toContain('keep this tab open');
    }
  });

  it('re-enables composer when no active approval wait remains', () => {
    state = roadexState({
      session: { ...baseSession, lifecycle: 'ready' },
      approvalWait: undefined,
      approvalComposerBlocked: false,
    });

    const html = renderAppMarkup();

    expect(html).not.toContain('aria-label="Human approval required"');
    expect(promptInputIsDisabled(html)).toBe(false);
  });
});
