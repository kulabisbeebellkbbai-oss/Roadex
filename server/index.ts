import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticate, gatewayAuthRequired, mockAuthToken, mockUser } from '../src/server/authService.js';
import {
  bootstrap,
  approveDeviceBridgeRequest,
  authorizeDeviceBridgeWrite,
  cancelSessionRun,
  closeSession,
  createDeviceInventoryBinding,
  createInitialState,
  attachApprovalLifecycleBridge,
  auditApprovalCoordinatorTransition,
  createSessionFromApi,
  dispatchApprovalContinuation,
  listDeviceArtifactMetadata,
  listArchivedSessions,
  listDeviceInventoryBindings,
  observeDeviceDescriptor,
  reopenSession,
  persistApprovalRuntimeState,
  publishApprovalCoordinatorSystemText,
  reportDeviceBridgeWrite,
  resolveActiveApprovalRunCapability,
  registerDeviceArtifactMetadata,
  requestDeviceBridgeIntake,
  startDeviceBridgeProbe,
  confirmDeviceBridgeProbe,
  deliverConfirmedDeviceArtifact,
  revokeDeviceArtifactMetadata,
  revokeDeviceInventoryBinding,
  subscribeToSessionStream,
  streamEventsForSession,
  submitPrompt,
  submitDeviceBridgeProbe,
  type RoadexState,
} from '../src/server/sessionService.js';
import {
  isAvailableDeviceBridgeIntakeRoute,
  isAvailableDeviceBridgeApprovalRoute,
  isAvailableDeviceBridgeMetadataRoute,
  isAvailableDeviceBridgeProbeRoute,
  isAvailableDeviceDescriptorObservationRoute,
} from '../src/server/deviceBridgePolicy.js';
import type { CreateSessionRequest } from '../src/shared/sessionContracts.js';
import { bindLiveStreamCleanup, resolveLiveStreamKeepaliveMs } from './liveStreamCleanup.js';
import { ProjectCreationBroker, type TeamEvidence } from '../src/server/projectCreationBroker.js';
import { isAvailableProjectCreationRoute } from '../src/server/projectCreationPolicy.js';
import { ProjectCreationWorker } from '../src/server/projectCreationWorker.js';
import { createControlledOperationGrantIssuer } from '../src/server/controlledOperationGrantIssuer.js';
import { ApprovalCoordinator, type ApprovalCoordinatorCallbacks } from '../src/server/approvalCoordinator.js';
import {
  createOverseerApprovalStatusProvider,
  type ApprovalStatusProvider,
  type OverseerProviderOptions,
} from '../src/server/approvalStatusProvider.js';
import { ApprovalWorkflowGrantBroker } from '../src/server/approvalWorkflowGrantBroker.js';
import {
  APPROVAL_WORKFLOW_SOCKET,
  startApprovalWorkflowHost,
  type ApprovalWorkflowHostOptions,
} from '../src/server/approvalWorkflowHost.js';
import { verifyLinuxPeerCredentials } from '../src/server/controlledOperationsPeer.js';

const DEFAULT_APPROVAL_POLL_MS = 2_000;
const MIN_APPROVAL_POLL_MS = 250;
const MAX_APPROVAL_POLL_MS = 60_000;

type RuntimeCloseable = { close: () => void | Promise<void> };
type RuntimeTimer = { unref?: () => unknown };
type RuntimeCoordinator = Pick<
  ApprovalCoordinator,
  'recover' | 'tick' | 'closeSessionWait' | 'hasActiveWait' | 'completeContinuation' | 'register'
>;

type RuntimeAddress = { host: string; port: number };

export type RoadexRuntimeDependencies = {
  state?: RoadexState;
  env?: NodeJS.ProcessEnv;
  createApprovalTokenReader?: (env: NodeJS.ProcessEnv) => () => string;
  createApprovalProvider?: (options: OverseerProviderOptions) => ApprovalStatusProvider;
  coordinator?: RuntimeCoordinator;
  startWorkflowHost?: (
    options: ApprovalWorkflowHostOptions,
  ) => RuntimeCloseable | Promise<RuntimeCloseable>;
  startHttp?: (
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
    address: RuntimeAddress,
  ) => RuntimeCloseable | Promise<RuntimeCloseable>;
  setInterval?: (callback: () => void, milliseconds: number) => RuntimeTimer;
  clearInterval?: (timer: RuntimeTimer) => void;
  addSignalListener?: (signal: NodeJS.Signals, listener: () => void) => void;
  removeSignalListener?: (signal: NodeJS.Signals, listener: () => void) => void;
  log?: (message: string) => void;
};

export type RoadexRuntime = {
  state: RoadexState;
  coordinator: RuntimeCoordinator;
  broker: ApprovalWorkflowGrantBroker;
  shutdown: () => Promise<void>;
};

type RouteContext = {
  state: RoadexState;
  coordinator: Pick<RuntimeCoordinator, 'closeSessionWait'>;
  liveStreamKeepaliveMs: number;
  projectCreationBroker?: ProjectCreationBroker;
  projectCreationWorker?: ProjectCreationWorker;
};

export function resolveApprovalPollMs(value: string | undefined): number {
  if (value === undefined) return DEFAULT_APPROVAL_POLL_MS;
  if (!/^[1-9]\d*$/.test(value)) return DEFAULT_APPROVAL_POLL_MS;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= MIN_APPROVAL_POLL_MS && parsed <= MAX_APPROVAL_POLL_MS
    ? parsed
    : DEFAULT_APPROVAL_POLL_MS;
}

export async function startRoadexRuntime(
  dependencies: RoadexRuntimeDependencies = {},
): Promise<RoadexRuntime> {
  const env = dependencies.env ?? process.env;
  const host = env.HOST ?? '127.0.0.1';
  const port = resolvePort(env.PORT);
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error('approval_runtime_start_failed');
  }

  const state = dependencies.state ?? createInitialState();
  const broker = new ApprovalWorkflowGrantBroker();
  const createTokenReader = dependencies.createApprovalTokenReader ?? createRuntimeApprovalTokenReader;
  const createProvider = dependencies.createApprovalProvider ?? createOverseerApprovalStatusProvider;
  let workflowHost: RuntimeCloseable | undefined;
  let httpHost: RuntimeCloseable | undefined;
  let interval: RuntimeTimer | undefined;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;
  let tickInProgress: Promise<void> | undefined;

  try {
    const readToken = createTokenReader(env);
    const provider = createProvider({ readToken });
    const callbacks: ApprovalCoordinatorCallbacks = {
      persist: () => persistApprovalRuntimeState(state),
      publish: (sessionId, message) => publishApprovalCoordinatorSystemText(state, sessionId, message),
      audit: (action, outcome, summary, resource) =>
        auditApprovalCoordinatorTransition(state, action, outcome, summary, resource),
      queueContinuation: (wait, prompt) => shuttingDown
        ? Promise.resolve({ status: 'ambiguous' as const })
        : dispatchApprovalContinuation(state, wait, prompt),
    };
    const coordinator: RuntimeCoordinator = dependencies.coordinator
      ?? new ApprovalCoordinator(state.approvalWaits, state.sessions.sessions, provider, callbacks);

    attachApprovalLifecycleBridge(state, {
      hasActiveWait: (sessionId) => coordinator.hasActiveWait(sessionId),
      issueWorkflowGrant: (scope) => broker.issue(scope).token,
      revokeWorkflowGrant: (runId) => broker.revokeRun(runId),
      completeContinuation: (continuationId, runnerRunId, outcome) =>
        coordinator.completeContinuation(continuationId, runnerRunId, outcome),
    });

    const projectServices: RouteContext = {
      state,
      coordinator,
      liveStreamKeepaliveMs: resolveLiveStreamKeepaliveMs(env.ROADEX_SSE_KEEPALIVE_MS),
    };
    state.resolveControlledRunnerGrant = (context) =>
      getProjectCreationBroker(projectServices).resolveControlledRunnerGrant({
        userId: context.userId,
        workspaceId: context.workspaceId,
        workspaceRoot: context.workspaceRoot ?? '',
        managedThreadId: context.managedThreadId,
        codexThreadId: context.codexThreadId,
      });
    state.issueControlledOperationToken = createControlledOperationGrantIssuer(env);

    const workflowOptions: ApprovalWorkflowHostOptions = {
      enabled: true,
      socketPath: APPROVAL_WORKFLOW_SOCKET,
      verifyPeer: verifyLinuxPeerCredentials,
      resolveRunCapability: (runId) => resolveActiveApprovalRunCapability(state, runId),
      register: (capability, input) => coordinator.register(capability, input),
      broker,
    };
    workflowHost = await (dependencies.startWorkflowHost ?? startDefaultWorkflowHost)(workflowOptions);
    await coordinator.recover();

    const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      try {
        await route(projectServices, req, res);
      } catch {
        sendJson(res, 500, { error: { code: 'internal_error', message: 'Unexpected server error.' } });
      }
    };
    httpHost = await (dependencies.startHttp ?? startDefaultHttp)(handler, { host, port });

    const schedule = dependencies.setInterval ?? ((callback, milliseconds) => setInterval(callback, milliseconds));
    const clearScheduled = dependencies.clearInterval ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>));
    interval = schedule(() => {
      if (shuttingDown || tickInProgress !== undefined) return;
      tickInProgress = Promise.resolve(coordinator.tick())
        .catch(() => undefined)
        .finally(() => { tickInProgress = undefined; });
    }, resolveApprovalPollMs(env.ROADEX_APPROVAL_POLL_MS));
    interval.unref?.();

    const removeSignal = dependencies.removeSignalListener ?? ((signal, listener) => process.off(signal, listener));
    const signalHandler = () => { void shutdown().catch(() => undefined); };
    const shutdown = (): Promise<void> => {
      shutdownPromise ??= (async () => {
        let failed = false;
        shuttingDown = true;
        if (interval !== undefined) {
          clearScheduled(interval);
          interval = undefined;
        }
        removeSignal('SIGTERM', signalHandler);
        removeSignal('SIGINT', signalHandler);
        if (workflowHost !== undefined) {
          try { await workflowHost.close(); } catch { failed = true; }
        }
        for (const runId of state.activeApprovalRuns.keys()) {
          try { broker.revokeRun(runId); } catch { failed = true; }
        }
        if (httpHost !== undefined) {
          try { await httpHost.close(); } catch { failed = true; }
        }
        if (failed) throw new Error('approval_runtime_shutdown_failed');
      })();
      return shutdownPromise;
    };
    const addSignal = dependencies.addSignalListener ?? ((signal, listener) => process.on(signal, listener));
    addSignal('SIGTERM', signalHandler);
    addSignal('SIGINT', signalHandler);
    (dependencies.log ?? console.log)(`Roadex API listening at http://${host}:${port}`);

    return { state, coordinator, broker, shutdown };
  } catch {
    shuttingDown = true;
    if (interval !== undefined) {
      (dependencies.clearInterval ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>)))(interval);
    }
    if (workflowHost !== undefined) {
      try { await workflowHost.close(); } catch { /* startup remains failed */ }
    }
    if (httpHost !== undefined) {
      try { await httpHost.close(); } catch { /* startup remains failed */ }
    }
    throw new Error('approval_runtime_start_failed');
  }
}

async function route(context: RouteContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { state, liveStreamKeepaliveMs } = context;
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, service: 'roadex-api' });
    return;
  }

  if (url.pathname === '/api/auth/mock-login' && req.method === 'POST') {
    if (gatewayAuthRequired()) {
      sendJson(res, 403, {
        error: {
          code: 'mock_auth_disabled',
          message: 'Mock Roadex login is disabled when protected gateway auth is configured.',
          gate: 'auth',
        },
      });
      return;
    }
    sendJson(res, 200, { user: mockUser, token: mockAuthToken });
    return;
  }

  if (url.pathname === '/api/bootstrap') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    sendJson(res, 200, await bootstrap(state, auth.user));
    return;
  }

  if (url.search === '' && isAvailableProjectCreationRoute(req.method, url.pathname)) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    if (req.method === 'POST' && !isJsonRequest(req)) {
      sendJson(res, 415, { error: { code: 'unsupported_media_type', message: 'JSON content type is required.' } });
      return;
    }
    const broker = getProjectCreationBroker(context);
    if (req.method === 'POST' && url.pathname === '/api/project-creation/proposals') {
      const result = await broker.createProposal(auth.user, await readJson<unknown>(req, 64_000));
      sendJson(res, result ? 201 : 403, result ? { ok: true, proposal: result } : projectCreationDenied());
      return;
    }
    const match = url.pathname.match(/^\/api\/project-creation\/proposals\/([A-Za-z0-9_-]{1,128})(?:\/(challenge|confirm|revoke))?$/);
    if (!match) {
      sendJson(res, 404, { error: { code: 'not_found', message: 'Route not found.' } });
      return;
    }
    const proposalId = match[1];
    const action = match[2];
    if (req.method === 'GET' && !action) {
      const result = broker.get(auth.user, proposalId);
      sendJson(res, result ? 200 : 404, result ? { ok: true, proposal: result } : projectCreationDenied());
      return;
    }
    if (req.method === 'POST' && action === 'challenge') {
      const result = await broker.createChallenge(auth.user, proposalId);
      sendJson(res, result ? 200 : 403, result ? { ok: true, challenge: result } : projectCreationDenied());
      return;
    }
    if (req.method === 'POST' && action === 'confirm') {
      const result = await broker.confirm(auth.user, proposalId, await readJson<unknown>(req, 4_096));
      sendJson(res, result ? 200 : 403, result ? { ok: true, proposal: result } : projectCreationDenied());
      if (result?.operation) {
        queueMicrotask(() => void getProjectCreationWorker(context).run(auth.user, proposalId));
      }
      return;
    }
    if (req.method === 'POST' && action === 'revoke') {
      const result = broker.revoke(auth.user, proposalId);
      sendJson(res, result ? 200 : 403, result ? { ok: true, proposal: result } : projectCreationDenied());
      return;
    }
  }

  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    sendJson(res, 200, { sessions: listArchivedSessions(state, auth.user) });
    return;
  }

  if (url.pathname === '/api/sessions' && req.method === 'POST') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const body = await readJson<CreateSessionRequest>(req);
    const response = await createSessionFromApi(state, auth.user, body);
    sendJson(res, response.ok ? 201 : 403, response);
    return;
  }

  const promptMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/prompts$/);
  if (promptMatch && req.method === 'POST') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const body = await readJson<{ prompt?: string }>(req);
    const result = await submitPrompt(state, auth.user, decodeURIComponent(promptMatch[1]), body.prompt ?? '');
    if (!result) {
      sendJson(res, 404, { error: { code: 'not_found', message: 'Session not found.' } });
      return;
    }
    sendJson(res, 202, result);
    return;
  }

  const cancelMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === 'POST') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const result = cancelSessionRun(state, auth.user, decodeURIComponent(cancelMatch[1]));
    if (!result) {
      sendJson(res, 404, { error: { code: 'not_found', message: 'No active session runner found.' } });
      return;
    }
    sendJson(res, result.cancelled ? 202 : 409, result);
    return;
  }

  const closeMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/close$/);
  if (closeMatch && req.method === 'POST') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const sessionId = decodeURIComponent(closeMatch[1]);
    const result = closeSession(state, auth.user, sessionId);
    if (!result) {
      sendJson(res, 404, { error: { code: 'not_found', message: 'Session not found.' } });
      return;
    }
    await context.coordinator.closeSessionWait(sessionId);
    sendJson(res, 202, result);
    return;
  }

  const reopenMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/reopen$/);
  if (reopenMatch && req.method === 'POST') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const result = reopenSession(state, auth.user, decodeURIComponent(reopenMatch[1]));
    if (!result) {
      sendJson(res, 404, { error: { code: 'not_found', message: 'Archived session not found.' } });
      return;
    }
    sendJson(res, result.reopened ? 200 : 409, result);
    return;
  }

  const deviceBridgeRequestMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/device-bridge\/requests$/);
  if (deviceBridgeRequestMatch && isAvailableDeviceBridgeIntakeRoute(req.method, url.pathname)) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const body = await readJson<unknown>(req);
    const result = requestDeviceBridgeIntake(
      state,
      auth.user,
      decodeURIComponent(deviceBridgeRequestMatch[1]),
      body,
    );
    sendJson(res, result.ok ? 202 : 403, result.ok ? result : {
      ok: false,
      gate: result.gate,
      reason: result.reason,
    });
    return;
  }

  const descriptorObservationMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/device-bridge\/observations$/);
  if (descriptorObservationMatch && isAvailableDeviceDescriptorObservationRoute(req.method, url.pathname)) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const body = await readJson<unknown>(req);
    const result = observeDeviceDescriptor(
      state,
      auth.user,
      decodeURIComponent(descriptorObservationMatch[1]),
      body,
    );
    sendJson(res, result.ok ? 201 : 403, result);
    return;
  }

  const deviceBridgeApprovalMatch = url.pathname.match(/^\/api\/device-bridge\/requests\/([^/]+)\/approve$/);
  if (deviceBridgeApprovalMatch && isAvailableDeviceBridgeApprovalRoute(req.method, url.pathname)) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const result = approveDeviceBridgeRequest(
      state,
      auth.user,
      decodeURIComponent(deviceBridgeApprovalMatch[1]),
    );
    sendJson(res, result.ok ? 201 : 403, result.ok ? result : {
      ok: false,
      gate: result.gate,
      reason: result.reason,
    });
    return;
  }

  const deviceBridgeProbeStartMatch = url.pathname.match(/^\/api\/device-bridge\/approvals\/([^/]+)\/start-probe$/);
  if (deviceBridgeProbeStartMatch && isAvailableDeviceBridgeProbeRoute(req.method, url.pathname)) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const result = startDeviceBridgeProbe(state, auth.user, decodeURIComponent(deviceBridgeProbeStartMatch[1]));
    sendJson(res, result.ok ? 201 : 403, result);
    return;
  }

  const deviceBridgeProbeMatch = url.pathname.match(/^\/api\/device-bridge\/operations\/([^/]+)\/probe$/);
  if (deviceBridgeProbeMatch && isAvailableDeviceBridgeProbeRoute(req.method, url.pathname)) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const body = await readJson<unknown>(req);
    const result = submitDeviceBridgeProbe(state, auth.user, decodeURIComponent(deviceBridgeProbeMatch[1]), body);
    sendJson(res, result.ok ? 200 : result.classification?.endsWith('mismatch') ? 409 : 403, result);
    return;
  }

  const deviceBridgeConfirmationMatch = url.pathname.match(/^\/api\/device-bridge\/operations\/([^/]+)\/confirm$/);
  if (deviceBridgeConfirmationMatch && isAvailableDeviceBridgeProbeRoute(req.method, url.pathname)) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const body = await readJson<unknown>(req);
    const result = confirmDeviceBridgeProbe(state, auth.user, decodeURIComponent(deviceBridgeConfirmationMatch[1]), body);
    sendJson(res, result.ok ? 200 : 403, result);
    return;
  }

  const deviceBridgeArtifactDeliveryMatch = url.pathname.match(/^\/api\/device-bridge\/operations\/([^/]+)\/artifact$/);
  if (deviceBridgeArtifactDeliveryMatch && isAvailableDeviceBridgeProbeRoute(req.method, url.pathname)) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const result = deliverConfirmedDeviceArtifact(state, auth.user, decodeURIComponent(deviceBridgeArtifactDeliveryMatch[1]));
    if (!result.ok) {
      sendJson(res, 403, { error: { code: 'device_bridge_denied', message: 'Firmware delivery denied.', gate: 'device-bridge' } });
      return;
    }
    res.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'application/octet-stream',
      'content-length': result.bytes.byteLength,
      'x-content-type-options': 'nosniff',
      'x-roadex-artifact-sha256': result.sha256,
    });
    res.end(result.bytes);
    return;
  }

  const deviceBridgeWriteAuthorizationMatch = url.pathname.match(/^\/api\/device-bridge\/operations\/([^/]+)\/authorize-write$/);
  if (deviceBridgeWriteAuthorizationMatch && isAvailableDeviceBridgeProbeRoute(req.method, url.pathname)) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const body = await readJson<unknown>(req);
    const result = authorizeDeviceBridgeWrite(state, auth.user, decodeURIComponent(deviceBridgeWriteAuthorizationMatch[1]), body);
    sendJson(res, result.ok ? 200 : 403, result);
    return;
  }

  const deviceBridgeWriteReportMatch = url.pathname.match(/^\/api\/device-bridge\/operations\/([^/]+)\/report$/);
  if (deviceBridgeWriteReportMatch && isAvailableDeviceBridgeProbeRoute(req.method, url.pathname)) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const body = await readJson<unknown>(req);
    const result = reportDeviceBridgeWrite(state, auth.user, decodeURIComponent(deviceBridgeWriteReportMatch[1]), body);
    sendJson(res, result.ok ? 200 : 403, result);
    return;
  }

  const deviceBridgeArtifactCollectionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/device-bridge\/artifacts$/);
  if (deviceBridgeArtifactCollectionMatch && isAvailableDeviceBridgeMetadataRoute(req.method, url.pathname)) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const sessionId = decodeURIComponent(deviceBridgeArtifactCollectionMatch[1]);
    if (req.method === 'GET') {
      const artifacts = listDeviceArtifactMetadata(state, auth.user, sessionId);
      sendJson(res, artifacts ? 200 : 403, artifacts ? { artifacts } : {
        error: { code: 'device_bridge_denied', message: 'Device bridge metadata denied.', gate: 'device-bridge' },
      });
      return;
    }
    const body = await readJson<unknown>(req);
    const result = registerDeviceArtifactMetadata(state, auth.user, sessionId, body);
    sendJson(res, result.ok ? 201 : 403, result);
    return;
  }

  const deviceBridgeArtifactRevokeMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/device-bridge\/artifacts\/([^/]+)\/revoke$/);
  if (deviceBridgeArtifactRevokeMatch && isAvailableDeviceBridgeMetadataRoute(req.method, url.pathname)) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const result = revokeDeviceArtifactMetadata(
      state,
      auth.user,
      decodeURIComponent(deviceBridgeArtifactRevokeMatch[1]),
      decodeURIComponent(deviceBridgeArtifactRevokeMatch[2]),
    );
    sendJson(res, result.ok ? 200 : 403, result);
    return;
  }

  if (url.pathname === '/api/device-bridge/inventory-bindings' && isAvailableDeviceBridgeMetadataRoute(req.method, url.pathname)) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    if (req.method === 'GET') {
      const projectId = url.searchParams.get('projectId') ?? '';
      const bindings = listDeviceInventoryBindings(state, auth.user, projectId);
      sendJson(res, bindings ? 200 : 403, bindings ? { bindings } : {
        error: { code: 'device_bridge_denied', message: 'Device bridge inventory binding denied.', gate: 'device-bridge' },
      });
      return;
    }
    const body = await readJson<unknown>(req);
    const result = createDeviceInventoryBinding(state, auth.user, body);
    sendJson(res, result.ok ? 201 : 403, result);
    return;
  }

  const inventoryRevokeMatch = url.pathname.match(/^\/api\/device-bridge\/inventory-bindings\/([^/]+)\/revoke$/);
  if (inventoryRevokeMatch && isAvailableDeviceBridgeMetadataRoute(req.method, url.pathname)) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const result = revokeDeviceInventoryBinding(state, auth.user, decodeURIComponent(inventoryRevokeMatch[1]));
    sendJson(res, result.ok ? 200 : 403, result);
    return;
  }

  const streamMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/stream$/);
  if (streamMatch && req.method === 'GET') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const sessionId = decodeURIComponent(streamMatch[1]);
    if (url.searchParams.get('live') === '1') {
      const subscription = subscribeToSessionStream(state, auth.user, sessionId, (event) => writeSseEvent(res, event));
      if (!subscription) {
        sendJson(res, 404, { error: { code: 'not_found', message: 'Session not found.' } });
        return;
      }
      writeSseHeaders(res);
      for (const event of subscription.snapshot) {
        writeSseEvent(res, event);
      }
      const keepalive = setInterval(() => {
        if (!subscription.isAuthorized()) {
          cleanup();
          res.end();
          return;
        }
        res.write(`: keepalive\n\n`);
      }, liveStreamKeepaliveMs);
      const cleanup = bindLiveStreamCleanup(req, res, () => {
        clearInterval(keepalive);
        subscription.unsubscribe();
      });
      return;
    }

    const events = streamEventsForSession(state, auth.user, sessionId);
    if (!events) {
      sendJson(res, 404, { error: { code: 'not_found', message: 'Session not found.' } });
      return;
    }
    writeSse(res, events);
    return;
  }

  if (req.method === 'GET') {
    const served = await tryServeStatic(url.pathname, res);
    if (served) return;
  }

  sendJson(res, 404, { error: { code: 'not_found', message: 'Route not found.' } });
}

function requireAuth(
  req: IncomingMessage,
  res: ServerResponse,
): ReturnType<typeof authenticate> & { ok: true } | undefined {
  const result = authenticate(req.headers);
  if (!result.ok) {
    sendJson(res, 401, { error: { code: 'unauthorized', message: result.reason, gate: 'auth' } });
    return undefined;
  }
  return result;
}

async function readJson<T>(req: IncomingMessage, maxBytes = 1_000_000): Promise<T> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error('request_body_too_large');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return (raw ? JSON.parse(raw) : {}) as T;
}

function isJsonRequest(req: IncomingMessage): boolean {
  return /^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '');
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function getProjectCreationBroker(context: RouteContext): ProjectCreationBroker {
  context.projectCreationBroker ??= new ProjectCreationBroker({
    resolveSession(userId, sessionId) {
      const session = context.state.sessions.sessions.find((item) => item.id === sessionId && item.userId === userId);
      return session ? {
        id: session.id,
        userId: session.userId,
        workspaceId: session.workspace.id,
        managedThreadId: session.managedThreadId,
        lifecycle: session.lifecycle,
      } : undefined;
    },
    async resolveTeam(teamId) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2_000);
      try {
        const response = await fetch(`http://127.0.0.1:8795/api/teams/${encodeURIComponent(teamId)}`, {
          signal: controller.signal,
        });
        if (!response.ok) return undefined;
        const raw = await response.text();
        if (Buffer.byteLength(raw) > 64_000) return undefined;
        const parsed = JSON.parse(raw) as { team?: unknown };
        return parsed.team && typeof parsed.team === 'object' ? parsed.team as TeamEvidence : undefined;
      } catch {
        return undefined;
      } finally {
        clearTimeout(timeout);
      }
    },
  });
  return context.projectCreationBroker;
}

function getProjectCreationWorker(context: RouteContext): ProjectCreationWorker {
  context.projectCreationWorker ??= new ProjectCreationWorker(getProjectCreationBroker(context));
  return context.projectCreationWorker;
}

function projectCreationDenied(): { ok: false; error: { code: string; message: string } } {
  return {
    ok: false,
    error: {
      code: 'project_creation_denied',
      message: 'Project creation request denied.',
    },
  };
}

function writeSse(res: ServerResponse, events: unknown[]): void {
  writeSseHeaders(res);
  for (const event of events) {
    writeSseEvent(res, event);
  }
  res.end();
}

function writeSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
}

function writeSseEvent(res: ServerResponse, event: unknown): void {
  res.write(`event: roadex\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function tryServeStatic(pathname: string, res: ServerResponse): Promise<boolean> {
  const cleanPath = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  if (cleanPath.startsWith('..')) return false;

  const filePath = join(process.cwd(), 'dist', cleanPath);
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': contentType(filePath) });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

function contentType(path: string): string {
  switch (extname(path)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

function createRuntimeApprovalTokenReader(env: NodeJS.ProcessEnv): () => string {
  return () => env.ROADEX_OVERSEER_APPROVAL_STATUS_TOKEN ?? '';
}

function resolvePort(value: string | undefined): number {
  if (value === undefined) return 8780;
  if (!/^[1-9]\d{0,4}$/.test(value)) throw new Error('approval_runtime_start_failed');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 65_535) throw new Error('approval_runtime_start_failed');
  return parsed;
}

async function startDefaultWorkflowHost(options: ApprovalWorkflowHostOptions): Promise<RuntimeCloseable> {
  const server = startApprovalWorkflowHost(options);
  await waitForListening(server);
  return { close: () => closeNodeServer(server) };
}

async function startDefaultHttp(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  address: RuntimeAddress,
): Promise<RuntimeCloseable> {
  const server = createServer(handler as RequestListener);
  await new Promise<void>((resolve, reject) => {
    const onError = () => {
      server.off('listening', onListening);
      reject(new Error('http_listen_failed'));
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(address.port, address.host);
  });
  return { close: () => closeNodeServer(server) };
}

async function waitForListening(server: ReturnType<typeof startApprovalWorkflowHost>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = () => {
      cleanup();
      reject(new Error('approval_workflow_host_failed'));
    };
    const onClose = () => {
      cleanup();
      reject(new Error('approval_workflow_host_failed'));
    };
    const onListening = () => {
      setImmediate(() => {
        if (!server.listening) {
          onClose();
          return;
        }
        cleanup();
        resolve();
      });
    };
    const cleanup = () => {
      server.off('error', onError);
      server.off('close', onClose);
      server.off('listening', onListening);
    };
    server.once('error', onError);
    server.once('close', onClose);
    server.once('listening', onListening);
  });
}

function closeNodeServer(server: { close: (callback: (error?: Error) => void) => unknown }): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  void startRoadexRuntime().catch(() => {
    console.error('Roadex API failed to start.');
    process.exitCode = 1;
  });
}
