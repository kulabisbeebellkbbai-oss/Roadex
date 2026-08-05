import { describe, expect, it, vi } from 'vitest';
import { mockUser } from '../src/server/authService';
import { ApprovalCoordinator } from '../src/server/approvalCoordinator';
import {
  createApprovalCoordinatorCallbacks,
  createInitialState,
} from '../src/server/sessionService';
import { createMemoryPersistence, type StatePersistence } from '../src/server/statePersistence';
import type { NormalizedApprovalStatus } from '../src/shared/approvalWorkflowContracts';
import type { RoadexSession } from '../src/shared/sessionContracts';

const NOW = '2026-08-04T00:00:00.000Z';

function sessionFixture(): RoadexSession {
  return {
    id: 'session-registration',
    userId: mockUser.id,
    workspace: { id: 'roadex', name: 'Roadex', root: '/roadex' },
    lifecycle: 'ready',
    runnerMode: 'codex',
    transport: 'sse',
    deviceBridge: 'disabled',
    gates: [],
    createdAt: NOW,
    updatedAt: NOW,
    codexThreadId: 'thread-registration',
    managedThreadId: 'thread-registration',
  };
}

function statusFixture(): NormalizedApprovalStatus {
  return {
    provider: 'overseer',
    approvalRef: 'approval-registration',
    authorityClass: 'privileged-operation',
    decision: 'pending',
    decisionVersion: `sha256:${'a'.repeat(64)}`,
    projectId: 'roadex',
    workspaceId: 'roadex',
    resourceRef: 'resource-registration',
    subject: 'Registration approval',
    updatedAt: NOW,
  };
}

describe('authoritative approval registration commit', () => {
  it('saves wait, paused summary, stream event, and audit in one authoritative commit', async () => {
    const memory = createMemoryPersistence();
    let saveCalls = 0;
    const persistence: StatePersistence = {
      load: memory.load,
      readAuthoritative: memory.readAuthoritative,
      save: (state) => {
        saveCalls += 1;
        memory.save(state);
      },
    };
    const state = createInitialState(undefined, persistence);
    const session = sessionFixture();
    state.sessions.sessions.push(session);
    state.managedThreadClaims.set(session.managedThreadId!, {
      threadId: session.managedThreadId!,
      userId: session.userId,
      claimedAt: NOW,
    });
    const coordinator = new ApprovalCoordinator(
      state.approvalWaits,
      state.sessions.sessions,
      { getStatus: vi.fn(async () => statusFixture()) },
      createApprovalCoordinatorCallbacks(state, async () => ({ status: 'started', runnerRunId: 'never-used' })),
      { idSource: { generateWaitId: () => 'wait-registration' }, clock: { now: () => NOW } },
    );

    const result = await coordinator.register(
      {
        sessionId: session.id,
        userId: mockUser.id,
        projectId: 'roadex',
        workspaceId: 'roadex',
        resourceRef: 'resource-registration',
        managedThreadId: 'thread-registration',
      },
      { provider: 'overseer', approvalRef: 'approval-registration' },
    );

    expect(result).toMatchObject({ ok: true, wait: { waitId: 'wait-registration', state: 'pending' } });
    expect(saveCalls).toBe(1);
    const durable = memory.load();
    expect(durable.approvalWaits).toHaveLength(1);
    expect(durable.sessions[0].waitingApproval).toMatchObject({ waitId: 'wait-registration', state: 'pending' });
    expect(durable.streamEvents.filter((event) => event.message.includes('waiting for human approval'))).toHaveLength(1);
    expect(durable.auditEvents.filter((event) => event.action === 'approval_wait.register')).toHaveLength(1);

    const recovered = createInitialState(undefined, persistence);
    expect(recovered.approvalWaits).toHaveLength(1);
    expect(recovered.approvalWaits[0].state).toBe('pending');
    expect(recovered.sessions.sessions[0].lifecycle).toBe('paused');
    expect(recovered.sessions.sessions[0].waitingApproval).toMatchObject({
      waitId: 'wait-registration',
      state: 'pending',
    });
  });
});
