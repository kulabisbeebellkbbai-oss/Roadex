import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { authenticate, gatewayAuthRequired, mockAuthToken, mockUser } from '../src/server/authService.js';
import {
  bootstrap,
  approveDeviceBridgeRequest,
  authorizeDeviceBridgeWrite,
  cancelSessionRun,
  closeSession,
  createDeviceInventoryBinding,
  createInitialState,
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
} from '../src/server/sessionService.js';
import {
  isAvailableDeviceBridgeIntakeRoute,
  isAvailableDeviceBridgeApprovalRoute,
  isAvailableDeviceBridgeMetadataRoute,
  isAvailableDeviceBridgeProbeRoute,
  isAvailableDeviceDescriptorObservationRoute,
} from '../src/server/deviceBridgePolicy.js';
import type { CreateSessionRequest } from '../src/shared/sessionContracts.js';
import { bindLiveStreamCleanup } from './liveStreamCleanup.js';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8780);
const state = createInitialState();

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

server.listen(port, host, () => {
  console.log(`Roadex API listening at http://${host}:${port}`);
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
    const result = closeSession(state, auth.user, decodeURIComponent(closeMatch[1]));
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
      }, 25_000);
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

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return (raw ? JSON.parse(raw) : {}) as T;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
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
