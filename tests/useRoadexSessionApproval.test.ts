import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DependencyList, EffectCallback, SetStateAction } from 'react';
import type { RoadexBootstrap, StreamEvent } from '../src/shared/sessionContracts';

type HookSlot =
  | { kind: 'state'; value: unknown; setter: (value: SetStateAction<unknown>) => void }
  | { kind: 'ref'; value: { current: unknown } }
  | { kind: 'memo'; value: unknown; dependencies: DependencyList }
  | { kind: 'effect'; dependencies: DependencyList; cleanup?: () => void };

type PendingEffect = {
  index: number;
  effect: EffectCallback;
  dependencies: DependencyList;
};

let activeHookRunner: HookRunner<unknown> | undefined;

class HookRunner<Result> {
  readonly #hook: () => Result;
  readonly #slots: HookSlot[] = [];
  #cursor = 0;
  #scheduled = false;
  #pendingEffects: PendingEffect[] = [];
  value: Result | undefined;

  constructor(hook: () => Result) {
    this.#hook = hook;
  }

  render(): void {
    this.#cursor = 0;
    this.#pendingEffects = [];
    activeHookRunner = this as HookRunner<unknown>;
    try {
      this.value = this.#hook();
    } finally {
      activeHookRunner = undefined;
    }

    for (const pending of this.#pendingEffects) {
      const existing = this.#slots[pending.index];
      if (existing?.kind === 'effect') existing.cleanup?.();
      const cleanup = pending.effect();
      this.#slots[pending.index] = {
        kind: 'effect',
        dependencies: pending.dependencies,
        ...(typeof cleanup === 'function' ? { cleanup } : {}),
      };
    }
  }

  unmount(): void {
    for (const slot of this.#slots) {
      if (slot.kind === 'effect') slot.cleanup?.();
    }
  }

  useState<Value>(initial: Value | (() => Value)): [Value, (value: SetStateAction<Value>) => void] {
    const index = this.#cursor++;
    let slot = this.#slots[index];
    if (!slot) {
      const initialValue = typeof initial === 'function' ? (initial as () => Value)() : initial;
      const stateSlot: Extract<HookSlot, { kind: 'state' }> = {
        kind: 'state',
        value: initialValue,
        setter: (action) => {
          const previous = stateSlot.value;
          const next = typeof action === 'function'
            ? (action as (value: unknown) => unknown)(previous)
            : action;
          if (Object.is(previous, next)) return;
          stateSlot.value = next;
          this.#scheduleRender();
        },
      };
      this.#slots[index] = stateSlot;
      slot = stateSlot;
    }
    if (slot.kind !== 'state') throw new Error('Hook order changed at useState.');
    return [slot.value as Value, slot.setter as (value: SetStateAction<Value>) => void];
  }

  useRef<Value>(initial: Value): { current: Value } {
    const index = this.#cursor++;
    let slot = this.#slots[index];
    if (!slot) {
      slot = { kind: 'ref', value: { current: initial } };
      this.#slots[index] = slot;
    }
    if (slot.kind !== 'ref') throw new Error('Hook order changed at useRef.');
    return slot.value as { current: Value };
  }

  useMemo<Value>(factory: () => Value, dependencies: DependencyList): Value {
    const index = this.#cursor++;
    const slot = this.#slots[index];
    if (slot?.kind === 'memo' && dependenciesMatch(slot.dependencies, dependencies)) {
      return slot.value as Value;
    }
    const value = factory();
    this.#slots[index] = { kind: 'memo', value, dependencies };
    return value;
  }

  useEffect(effect: EffectCallback, dependencies: DependencyList): void {
    const index = this.#cursor++;
    const slot = this.#slots[index];
    if (slot?.kind === 'effect' && dependenciesMatch(slot.dependencies, dependencies)) return;
    this.#pendingEffects.push({ index, effect, dependencies });
  }

  #scheduleRender(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      this.render();
    });
  }
}

function dependenciesMatch(left: DependencyList, right: DependencyList): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

function requireHookRunner(): HookRunner<unknown> {
  if (!activeHookRunner) throw new Error('A hook was called outside the test runner.');
  return activeHookRunner;
}

function bootstrapWithApproval(state: 'pending' | 'approved-resume-queued'): RoadexBootstrap {
  const workspace = { id: 'roadex', name: 'Roadex', root: '/srv/roadex' };
  return {
    user: { id: 'owner', displayName: 'Owner', authMode: 'mock', roles: ['user'] },
    workspaces: [workspace],
    sessions: [{
      id: 'session-approval-hook',
      userId: 'owner',
      workspace,
      lifecycle: 'paused',
      runnerMode: 'codex',
      transport: 'sse',
      deviceBridge: 'disabled',
      gates: [],
      createdAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
      waitingApproval: {
        waitId: 'wait-hook',
        approvalRef: 'overview.roadex.approval',
        subject: 'the approved Roadex plan',
        consoleSurface: 'overview',
        consolePath: '/Overseer/overview',
        state,
        updatedAt: '2026-08-02T00:00:00.000Z',
      },
    }],
    auditEvents: [],
    streamPreview: [],
    managedThreads: [],
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
    deviceInventoryBindingRefs: [],
    serialVerificationProfiles: [],
    bleVerificationProfiles: [],
    usbDeviceProfiles: [],
  };
}

afterEach(() => {
  vi.doUnmock('react');
  vi.doUnmock('../src/client/sessionApi');
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('useRoadexSession approval transition refresh', () => {
  it('hydrates one recognized intermediate SSE transition without reload or resubscription', async () => {
    vi.stubGlobal('window', {
      navigator: {},
      confirm: () => false,
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
      },
    });

    vi.doMock('react', async () => {
      const actual = await vi.importActual<typeof import('react')>('react');
      return {
        ...actual,
        useCallback: <Value extends (...args: never[]) => unknown>(callback: Value, dependencies: DependencyList) => (
          requireHookRunner().useMemo(() => callback, dependencies)
        ),
        useEffect: (effect: EffectCallback, dependencies: DependencyList) => (
          requireHookRunner().useEffect(effect, dependencies)
        ),
        useMemo: <Value>(factory: () => Value, dependencies: DependencyList) => (
          requireHookRunner().useMemo(factory, dependencies)
        ),
        useRef: <Value>(initial: Value) => requireHookRunner().useRef(initial),
        useState: <Value>(initial: Value | (() => Value)) => requireHookRunner().useState(initial),
      };
    });

    let bootstrapState: 'pending' | 'approved-resume-queued' = 'pending';
    const loginAndBootstrap = vi.fn(async () => ({
      token: 'stable-mock-token',
      bootstrap: bootstrapWithApproval(bootstrapState),
    }));
    const readSessionStream = vi.fn(async () => [] as StreamEvent[]);
    let streamListener: ((event: StreamEvent) => void) | undefined;
    const subscribeSessionStream = vi.fn((
      _token: string | undefined,
      _sessionId: string,
      onEvent: (event: StreamEvent) => void,
    ) => {
      streamListener = onEvent;
      return () => undefined;
    });

    vi.doMock('../src/client/sessionApi', async () => {
      const actual = await vi.importActual<typeof import('../src/client/sessionApi')>('../src/client/sessionApi');
      return {
        ...actual,
        listArchivedSessions: vi.fn(async () => ({ sessions: [] })),
        loginAndBootstrap,
        readSessionStream,
        subscribeSessionStream,
      };
    });

    const { useRoadexSession } = await import('../src/hooks/useRoadexSession');
    const runner = new HookRunner(useRoadexSession);
    runner.render();

    await vi.waitFor(() => {
      expect(loginAndBootstrap).toHaveBeenCalledTimes(1);
      expect(subscribeSessionStream).toHaveBeenCalledTimes(1);
      expect(runner.value?.approvalWait?.state).toBe('pending');
    });

    bootstrapState = 'approved-resume-queued';
    streamListener?.({
      id: 'event-approval-resume-queued',
      sessionId: 'session-approval-hook',
      kind: 'system',
      message: 'Roadex human approval result: approved-resume-queued',
      at: '2026-08-02T00:00:01.000Z',
    });

    await vi.waitFor(() => {
      expect(loginAndBootstrap).toHaveBeenCalledTimes(2);
      expect(runner.value?.approvalWait?.state).toBe('approved-resume-queued');
      expect(runner.value?.approvalComposerBlocked).toBe(true);
    });
    expect(subscribeSessionStream).toHaveBeenCalledTimes(1);
    expect(readSessionStream).toHaveBeenCalledTimes(2);

    runner.unmount();
  });
});
