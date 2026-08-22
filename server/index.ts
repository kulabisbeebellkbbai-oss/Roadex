import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize } from 'node:path';
import { authenticate, gatewayAuthRequired, mockAuthToken, mockUser } from '../src/server/authService.js';
import {
  bootstrap,
  approveDeviceBridgeRequest,
  authorizeDeviceBridgeWrite,
  cancelSessionRun,
  closeSession,
  createDeviceInventoryBinding,
  createInitialState,
  createApprovalContinuationDispatcher,
  createApprovalCoordinatorCallbacks,
  createApprovalShutdown,
  createApprovalWorkflowRunRuntime,
  createSessionFromApi,
  listDeviceArtifactMetadata,
  listArchivedSessions,
  listDeviceInventoryBindings,
  observeDeviceDescriptor,
  reopenSession,
  reportDeviceBridgeWrite,
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
  resolveApprovalPollMs,
  startApprovalPoller,
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
import { createOverseerApprovalStatusProvider } from '../src/server/approvalStatusProvider.js';
import { ApprovalCoordinator } from '../src/server/approvalCoordinator.js';
import { ApprovalWorkflowGrantBroker } from '../src/server/approvalWorkflowGrantBroker.js';
import { startApprovalWorkflowHost } from '../src/server/approvalWorkflowHost.js';
import { AppPublicationRequester } from '../src/server/appPublicationRequester.js';
import { isAvailableAppPublicationRoute } from '../src/server/appPublicationPolicy.js';
import { ProjectHumanThreadStore } from '../src/server/projectHumanThreadStore.js';
import { ProjectHumanThreadAuthority } from '../src/server/projectHumanThreadAuthority.js';
import { ProjectHumanThreadService } from '../src/server/projectHumanThreadService.js';
import { ProjectHumanThreadController } from '../src/server/projectHumanThreadController.js';
import { isAvailableProjectHumanThreadRoute, validProjectHumanThreadCsrf } from '../src/server/projectHumanThreadPolicy.js';
import { resolveWorkspaceForUser } from '../src/server/workspacePolicy.js';
import { ProjectHumanThreadRelay, ProjectHumanThreadRelayCoordinator } from '../src/server/projectHumanThreadRelay.js';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8780);
const liveStreamKeepaliveMs = resolveLiveStreamKeepaliveMs(process.env.ROADEX_SSE_KEEPALIVE_MS);
const state = createInitialState();
let projectCreationBroker: ProjectCreationBroker | undefined;
let projectCreationWorker: ProjectCreationWorker | undefined;
let appPublicationRequester: AppPublicationRequester | undefined;
let projectHumanThreadStore: ProjectHumanThreadStore | undefined;
let projectHumanThreadService: ProjectHumanThreadService | undefined;
let projectHumanThreadController: ProjectHumanThreadController | undefined;
let projectHumanThreadRelay: ProjectHumanThreadRelay | undefined;
let projectHumanThreadRelayCoordinator: ProjectHumanThreadRelayCoordinator | undefined;
state.resolveControlledRunnerGrant = (context) =>
  getProjectCreationBroker().resolveControlledRunnerGrant({
    userId: context.userId,
    workspaceId: context.workspaceId,
    workspaceRoot: context.workspaceRoot ?? '',
    managedThreadId: context.managedThreadId,
    codexThreadId: context.codexThreadId,
  });
state.issueControlledOperationToken = createControlledOperationGrantIssuer(process.env);

if (host !== '127.0.0.1' && host !== 'localhost') {
  throw new Error('Roadex API must bind to loopback until deployment gateway review is complete.');
}

const server = createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: { code: 'internal_error', message: 'Unexpected server error.' } });
  }
});

void startRoadexApi().catch(() => {
  console.error('Roadex API startup failed.');
  process.exitCode = 1;
});

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

  if (url.search === '' && isAvailableProjectHumanThreadRoute(req.method, url.pathname)) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const match = url.pathname.match(/^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,159})\/human-thread(?:\/(history|create|adopt|recover|replace))?$/);
    if (!match) {
      sendJson(res, 404, { error: { code: 'not_found', message: 'Route not found.' } });
      return;
    }
    const projectId = match[1];
    const action = match[2];
    const controller = getProjectHumanThreadController();
    try {
      if (req.method === 'GET') {
        sendJson(res, 200, action === 'history'
          ? { ok: true, history: controller.history(auth.user, projectId) }
          : { ok: true, ...controller.read(auth.user, projectId) });
        return;
      }
      if (!isJsonRequest(req)) {
        sendJson(res, 415, { error: { code: 'unsupported_media_type', message: 'JSON content type is required.' } });
        return;
      }
      if (!validProjectHumanThreadCsrf(req.headers['x-roadex-csrf'])) {
        sendJson(res, 403, { error: { code: 'csrf_required', message: 'Gateway CSRF validation is required.' } });
        return;
      }
      const idempotency = req.headers['idempotency-key'];
      if (typeof idempotency !== 'string') {
        sendJson(res, 400, { error: { code: 'idempotency_required', message: 'A valid idempotency key is required.' } });
        return;
      }
      const body = await readJson<unknown>(req, 8_192);
      const result = action === 'create'
        ? await controller.createMissing(auth.user, projectId, idempotency, body)
        : action === 'adopt'
          ? await controller.adopt(auth.user, projectId, idempotency, body)
          : action === 'recover'
            ? await controller.recover(auth.user, projectId, idempotency, body)
            : await controller.replace(auth.user, projectId, idempotency, body);
      const adoptionRequired = typeof result === 'object' && result !== null
        && 'outcome' in result && result.outcome === 'adoption-required';
      sendJson(res, adoptionRequired ? 409 : 200, { ok: !adoptionRequired, result });
      if (!adoptionRequired) scheduleProjectHumanThreadRelay();
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Project human thread request failed.';
      const notFound = /not found/i.test(message);
      const conflict = /conflict|active run|already has|ambiguous/i.test(message);
      sendJson(res, notFound ? 404 : conflict ? 409 : 400, {
        error: { code: notFound ? 'not_found' : conflict ? 'thread_conflict' : 'invalid_request', message },
      });
      return;
    }
  }

  if (url.search === '' && isAvailableProjectCreationRoute(req.method, url.pathname)) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    if (req.method === 'POST' && !isJsonRequest(req)) {
      sendJson(res, 415, { error: { code: 'unsupported_media_type', message: 'JSON content type is required.' } });
      return;
    }
    const broker = getProjectCreationBroker();
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
        queueMicrotask(() => void getProjectCreationWorker().run(auth.user, proposalId));
      }
      return;
    }
    if (req.method === 'POST' && action === 'revoke') {
      const result = broker.revoke(auth.user, proposalId);
      sendJson(res, result ? 200 : 403, result ? { ok: true, proposal: result } : projectCreationDenied());
      return;
    }
  }

  if (url.search === '' && isAvailableAppPublicationRoute(req.method, url.pathname)) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const requester = getAppPublicationRequester();
    if (req.method === 'POST' && url.pathname === '/api/app-publication/requests') {
      if (!isJsonRequest(req)) {
        sendJson(res, 415, { error: { code: 'unsupported_media_type', message: 'JSON content type is required.' } });
        return;
      }
      const keyHeader = req.headers['idempotency-key'];
      const key = typeof keyHeader === 'string' ? keyHeader : undefined;
      const result = requester.create(auth.user, key, await readJson<unknown>(req, 32_768));
      if (result.outcome === 'created' || result.outcome === 'replayed') {
        sendJson(res, result.outcome === 'created' ? 201 : 200, {
          ok: true,
          request: result.request,
          replayed: result.outcome === 'replayed',
        });
        return;
      }
      if (result.outcome === 'conflict') {
        sendJson(res, 409, {
          ok: false,
          error: {
            code: 'idempotency_conflict',
            message: 'The idempotency key is already bound to a different publication request.',
            gate: 'app-publication',
          },
        });
        return;
      }
      sendJson(res, 403, appPublicationDenied());
      return;
    }
    const match = url.pathname.match(/^\/api\/app-publication\/requests\/([A-Za-z0-9_-]{1,128})$/);
    if (req.method === 'GET' && match) {
      const request = requester.get(auth.user, match[1]);
      sendJson(res, request ? 200 : 404, request ? { ok: true, request } : appPublicationDenied());
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
    sendJson(res, result.accepted ? 202 : 409, result);
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
    const result = await closeSession(state, auth.user, decodeURIComponent(closeMatch[1]));
    if (!result) {
      sendJson(res, 404, { error: { code: 'not_found', message: 'Session not found.' } });
      return;
    }
    sendJson(res, 202, result);
    return;
  }

  const reopenMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/reopen$/);
  if (reopenMatch && req.method === 'POST') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const result = await reopenSession(state, auth.user, decodeURIComponent(reopenMatch[1]));
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

function getProjectCreationBroker(): ProjectCreationBroker {
  projectCreationBroker ??= new ProjectCreationBroker({
    resolveSession(userId, sessionId) {
      const session = state.sessions.sessions.find((item) => item.id === sessionId && item.userId === userId);
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
  return projectCreationBroker;
}

function getProjectCreationWorker(): ProjectCreationWorker {
  projectCreationWorker ??= new ProjectCreationWorker(
    getProjectCreationBroker(), undefined, undefined, {
      async provision(_user, lease, finalization) {
        if (!projectHumanThreadService) getProjectHumanThreadController();
        const provenanceDigest = createHash('sha256').update(JSON.stringify({
          operationId: lease.operationId,
          projectId: finalization.workspaceId,
          projectRoot: finalization.workspaceRoot,
          conversationId: finalization.managedThreadId,
        })).digest('hex');
        await projectHumanThreadService!.adopt({
          projectId: finalization.workspaceId,
          projectRoot: finalization.workspaceRoot,
          conversationId: finalization.managedThreadId,
          provenanceDigest,
          idempotencyKey: `project-human-thread:${lease.operationId}`,
        });
        scheduleProjectHumanThreadRelay();
      },
    },
  );
  return projectCreationWorker;
}

function getAppPublicationRequester(): AppPublicationRequester {
  appPublicationRequester ??= new AppPublicationRequester({
    workspaceBelongsToProject(userId, projectId, workspaceId) {
      return projectId === workspaceId && state.sessions.sessions.some((session) => (
        session.userId === userId && session.workspace.id === workspaceId
      ));
    },
  });
  return appPublicationRequester;
}

function getProjectHumanThreadController(): ProjectHumanThreadController {
  if (projectHumanThreadController) return projectHumanThreadController;
  projectHumanThreadStore = new ProjectHumanThreadStore();
  projectHumanThreadService = new ProjectHumanThreadService(projectHumanThreadStore, new ProjectHumanThreadAuthority());
  projectHumanThreadController = new ProjectHumanThreadController(projectHumanThreadService, {
    resolveOwnedProject(user, projectId) {
      const decision = resolveWorkspaceForUser(user, projectId);
      if (!decision.ok) return undefined;
      return {
        projectId: decision.workspace.id,
        root: decision.workspace.root,
        activeRun: state.sessions.sessions.some((session) => (
          session.userId === user.id
          && session.workspace.id === projectId
          && state.activeRuns.has(session.id)
        )),
      };
    },
  });
  return projectHumanThreadController;
}

function getProjectHumanThreadRelayCoordinator(): ProjectHumanThreadRelayCoordinator {
  if (projectHumanThreadRelayCoordinator) return projectHumanThreadRelayCoordinator;
  if (!projectHumanThreadStore) getProjectHumanThreadController();
  projectHumanThreadRelay = new ProjectHumanThreadRelay();
  projectHumanThreadRelayCoordinator = new ProjectHumanThreadRelayCoordinator(projectHumanThreadStore!, projectHumanThreadRelay);
  return projectHumanThreadRelayCoordinator;
}

function scheduleProjectHumanThreadRelay(): void {
  if (process.env.ROADEX_PROJECT_HUMAN_THREAD_RELAY_ENABLED !== 'true') return;
  queueMicrotask(() => {
    void getProjectHumanThreadRelayCoordinator().retryBindings().catch(() => {
      // The transactional binding outbox remains pending for the next retry.
    });
  });
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

function appPublicationDenied(): { ok: false; error: { code: string; message: string; gate: string } } {
  return {
    ok: false,
    error: {
      code: 'app_publication_denied',
      message: 'App publication request denied.',
      gate: 'app-publication',
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

async function startRoadexApi(): Promise<void> {
  const grantBroker = new ApprovalWorkflowGrantBroker();
  const workflowRuntime = createApprovalWorkflowRunRuntime(grantBroker);
  state.approvalWorkflowRuntime = workflowRuntime;
  const provider = createOverseerApprovalStatusProvider({
    readToken: readApprovalStatusToken,
  });
  const coordinatorRef: { current?: ApprovalCoordinator } = {};
  const queueContinuation = createApprovalContinuationDispatcher(state, {
    completeRunner: (...args) => {
      if (!coordinatorRef.current) {
        throw new Error('approval_coordinator_unavailable');
      }
      return coordinatorRef.current.completeRunner(...args);
    },
  });
  const coordinator = new ApprovalCoordinator(
    state.approvalWaits,
    state.sessions.sessions,
    provider,
    createApprovalCoordinatorCallbacks(state, queueContinuation),
    {
      authorizeStreamingRegistration: (session, capability) => {
        if (!capability.runnerRunId || !state.activeRuns.has(session.id)) {
          return false;
        }
        const active = workflowRuntime.resolveRunContext(capability.runnerRunId);
        return active?.runnerRunId === capability.runnerRunId
          && active.sessionId === capability.sessionId
          && active.userId === capability.userId
          && active.projectId === capability.projectId
          && active.workspaceId === capability.workspaceId
          && active.resourceRef === capability.resourceRef
          && active.managedThreadId === capability.managedThreadId;
      },
    },
  );
  coordinatorRef.current = coordinator;
  state.approvalLifecycleRuntime = {
    closeSessionWait: (sessionId) => coordinator.closeSessionWait(sessionId),
    reopenSessionWait: (sessionId) => coordinator.reopenSessionWait(sessionId),
    failUserRun: (sessionId, outcome) => coordinator.failUserRun(sessionId, outcome),
  };
  const workflowHost = startApprovalWorkflowHost({
    consumeGrant: (token) => grantBroker.consume(token),
    resolveRunContext: (runId) => workflowRuntime.resolveRunContext(runId),
    registerApprovalWait: (capability, input) => coordinator.register(capability, input),
  });
  await once(workflowHost, 'listening');
  await coordinator.recover();
  if (process.env.ROADEX_PROJECT_HUMAN_THREAD_ENABLED === 'true') {
    getProjectHumanThreadController();
    scheduleProjectHumanThreadRelay();
  }

  const poller = startApprovalPoller(
    coordinator,
    resolveApprovalPollMs(process.env.ROADEX_APPROVAL_POLL_MS),
  );
  const shutdown = createApprovalShutdown({
    stopPolling: () => clearInterval(poller as ReturnType<typeof setInterval>),
    closeWorkflowHost: () => new Promise<void>((resolveClose, rejectClose) => {
      workflowHost.close((error?: Error) => {
        if (error) {
          rejectClose(new Error('approval_workflow_host_close_failed'));
          return;
        }
        projectHumanThreadStore?.close();
        projectHumanThreadRelay?.close();
        resolveClose();
      });
    }),
    revokeOutstandingGrants: () => workflowRuntime.revokeOutstanding(),
    closeHttpServer: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((error?: Error) => {
        if (error) {
          rejectClose(new Error('roadex_http_close_failed'));
          return;
        }
        resolveClose();
      });
    }),
  });
  const handleSignal = (): void => {
    void shutdown().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', handleSignal);
  process.once('SIGINT', handleSignal);

  server.listen(port, host, () => {
    console.log(`Roadex API listening at http://${host}:${port}`);
  });
}

function readApprovalStatusToken(): string {
  const path = process.env.ROADEX_OVERSEER_APPROVAL_TOKEN_FILE;
  if (!path || !isAbsolute(path) || path.includes('\0')) {
    throw new Error('approval_status_token_unavailable');
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const descriptorStat = fstatSync(descriptor);
    const pathStat = lstatSync(path);
    if (
      !descriptorStat.isFile()
      || !pathStat.isFile()
      || pathStat.isSymbolicLink()
      || descriptorStat.uid !== process.getuid?.()
      || pathStat.uid !== descriptorStat.uid
      || pathStat.dev !== descriptorStat.dev
      || pathStat.ino !== descriptorStat.ino
      || (descriptorStat.mode & 0o077) !== 0
      || descriptorStat.size < 1
      || descriptorStat.size > 256
    ) {
      throw new Error('approval_status_token_unavailable');
    }
    const token = readFileSync(descriptor, 'utf8').trim();
    if (token.length === 0) {
      throw new Error('approval_status_token_unavailable');
    }
    return token;
  } catch {
    throw new Error('approval_status_token_unavailable');
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}
