import {
  firstMilestoneGates,
  type RoadexSession,
  type SessionRequest,
  type SessionResponse,
} from '../shared/sessionContracts';

const approvedWorkspaceRoot = '/srv/roadex/projects/';

export function createMockSession(request: SessionRequest): SessionResponse {
  if (!request.userId) {
    return deny('auth', 'Authentication is required before a Roadex session can be created.');
  }

  if (!request.workspace.root.startsWith(approvedWorkspaceRoot)) {
    return deny('workspace', 'Workspace must be selected from a server-approved project root.');
  }

  if (request.requestedDeviceBridge) {
    return deny('device-bridge', 'Client device bridge is disabled until the core portal passes review.');
  }

  const session: RoadexSession = {
    id: `mock-${request.workspace.id}`,
    userId: request.userId,
    workspace: request.workspace,
    lifecycle: 'ready',
    runnerMode: 'mock',
    transport: 'sse',
    deviceBridge: 'disabled',
    gates: firstMilestoneGates.map((gate) => ({
      ...gate,
      state:
        gate.id === 'device-bridge'
          ? 'deferred'
          : 'passed',
    })),
  };

  return { ok: true, session };
}

function deny(gate: string, reason: string): SessionResponse {
  return {
    ok: false,
    gate,
    reason,
  };
}
