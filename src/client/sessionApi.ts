import type {
  ApiError,
  ArchivedSessionsResponse,
  BootstrapResponse,
  CancelResponse,
  CloseResponse,
  MockLoginResponse,
  PromptResponse,
  ReopenResponse,
} from '../shared/apiContracts';
import type { CreateSessionRequest, RoadexSession, SessionResponse, StreamEvent } from '../shared/sessionContracts';
import type {
  DeviceArtifactMetadataPublic,
  DeviceBridgeApprovalPublic,
  DeviceBridgeApprovalResponse,
  DeviceBridgeProbeResponse,
  DeviceBridgeProbeStartResponse,
  DeviceBridgeConfirmationResponse,
  DeviceBridgeOperationPublic,
  DeviceBridgeWriteAuthorizationResponse,
  DeviceBridgeRequestPayload,
  DeviceBridgeRequestResponse,
  DeviceDescriptorObservationPayload,
  DeviceDescriptorObservationResponse,
} from '../shared/deviceBridgeContracts';
import { isApiError } from '../shared/apiContracts';

let csrfToken: string | undefined;

export type RoadexApiSession = {
  token?: string;
  bootstrap: BootstrapResponse;
};

export async function loginAndBootstrap(): Promise<RoadexApiSession> {
  const protectedBootstrap = await requestOptional<BootstrapResponse>('/api/bootstrap');
  if (protectedBootstrap.ok) {
    return {
      bootstrap: protectedBootstrap.payload,
    };
  }

  const login = await request<MockLoginResponse>('/api/auth/mock-login', {
    method: 'POST',
  });
  const bootstrap = await request<BootstrapResponse>('/api/bootstrap', {
    token: login.token,
  });

  return {
    token: login.token,
    bootstrap,
  };
}

export async function createSession(
  token: string | undefined,
  requestBody: CreateSessionRequest,
): Promise<{ bootstrap: BootstrapResponse; session: RoadexSession }> {
  const response = await request<SessionResponse>('/api/sessions', {
    method: 'POST',
    token,
    body: requestBody,
  });
  if (!response.ok) {
    throw new Error(response.reason);
  }

  return {
    bootstrap: await request<BootstrapResponse>('/api/bootstrap', { token }),
    session: response.session,
  };
}

export async function submitPrompt(
  token: string | undefined,
  sessionId: string,
  prompt: string,
): Promise<PromptResponse> {
  return request<PromptResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/prompts`, {
    method: 'POST',
    token,
    body: { prompt },
  });
}

export async function submitDeviceDescriptorObservation(
  token: string | undefined,
  sessionId: string,
  body: DeviceDescriptorObservationPayload,
): Promise<Extract<DeviceDescriptorObservationResponse, { ok: true }>> {
  const response = await request<DeviceDescriptorObservationResponse>(
    `/Roadex/api/sessions/${encodeURIComponent(sessionId)}/device-bridge/observations`,
    { method: 'POST', token, body, requestId: crypto.randomUUID() },
  );
  if (!response.ok) throw new Error(response.reason);
  return response;
}

export async function createDeviceBridgeProbeApproval(
  token: string | undefined,
  sessionId: string,
  body: DeviceBridgeRequestPayload,
): Promise<DeviceBridgeApprovalPublic> {
  const intake = await request<DeviceBridgeRequestResponse>(
    `/Roadex/api/sessions/${encodeURIComponent(sessionId)}/device-bridge/requests`,
    { method: 'POST', token, body, requestId: crypto.randomUUID() },
  );
  if (!intake.ok) throw new Error(intake.reason);

  const approval = await request<DeviceBridgeApprovalResponse>(
    `/Roadex/api/device-bridge/requests/${encodeURIComponent(intake.request.id)}/approve`,
    { method: 'POST', token, body: {}, requestId: crypto.randomUUID() },
  );
  if (!approval.ok) throw new Error(approval.reason);
  return approval.approval;
}

export async function listActiveDeviceArtifacts(
  token: string | undefined,
  sessionId: string,
): Promise<DeviceArtifactMetadataPublic[]> {
  const response = await request<{ artifacts: DeviceArtifactMetadataPublic[] }>(
    `/Roadex/api/sessions/${encodeURIComponent(sessionId)}/device-bridge/artifacts`,
    { token },
  );
  return response.artifacts;
}

export async function runDeviceBridgeProbe(
  token: string | undefined,
  approval: DeviceBridgeApprovalPublic,
  deviceMac: string,
): Promise<DeviceBridgeOperationPublic> {
  const started = await request<DeviceBridgeProbeStartResponse>(
    `/Roadex/api/device-bridge/approvals/${encodeURIComponent(approval.id)}/start-probe`,
    { method: 'POST', token, body: {}, requestId: crypto.randomUUID() },
  );
  if (!started.ok) throw new Error(started.reason);

  const completed = await request<DeviceBridgeProbeResponse>(
    `/Roadex/api/device-bridge/operations/${encodeURIComponent(started.operation.id)}/probe`,
    {
      method: 'POST',
      token,
      body: { artifactSha256: approval.artifactSha256, deviceMac },
      requestId: crypto.randomUUID(),
    },
  );
  if (!completed.ok) throw new Error(completed.reason);
  if (completed.operation.phase !== 'verified') throw new Error('The controlled device probe did not verify.');
  return completed.operation;
}

export async function confirmVerifiedDeviceProbe(token: string | undefined, operationId: string): Promise<DeviceBridgeOperationPublic> {
  const result = await request<DeviceBridgeConfirmationResponse>(`/Roadex/api/device-bridge/operations/${encodeURIComponent(operationId)}/confirm`, { method: 'POST', token, body: {}, requestId: crypto.randomUUID() });
  if (!result.ok) throw new Error(result.reason);
  if (result.operation.phase !== 'confirmation') throw new Error('Device confirmation was not recorded.');
  return result.operation;
}

export async function loadVerifiedFirmware(
  token: string | undefined,
  operation: DeviceBridgeOperationPublic,
): Promise<ArrayBuffer> {
  if (operation.phase !== 'confirmation') throw new Error('Fresh target confirmation is required.');
  const response = await fetch(`/Roadex/api/device-bridge/operations/${encodeURIComponent(operation.id)}/artifact`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Firmware delivery failed with status ${response.status}`);
  if (response.headers.get('content-type')?.split(';', 1)[0] !== 'application/octet-stream') {
    throw new Error('Firmware delivery returned an unexpected content type.');
  }
  const bytes = await response.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const actualSha256 = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
  const headerSha256 = response.headers.get('x-roadex-artifact-sha256');
  if (actualSha256 !== operation.artifactSha256 || headerSha256 !== operation.artifactSha256) {
    throw new Error('Firmware digest verification failed.');
  }
  return bytes;
}

export async function authorizeVerifiedFirmwareWrite(
  token: string | undefined,
  operation: DeviceBridgeOperationPublic,
  deviceMac: string,
): Promise<{ operation: DeviceBridgeOperationPublic; writeToken: string }> {
  const writeToken = randomWriteToken();
  const requestId = crypto.randomUUID();
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await request<DeviceBridgeWriteAuthorizationResponse>(
        `/Roadex/api/device-bridge/operations/${encodeURIComponent(operation.id)}/authorize-write`,
        { method: 'POST', token, body: { artifactSha256: operation.artifactSha256, deviceMac, writeToken }, requestId },
      );
      if (!result.ok) throw new Error(result.reason);
      if (result.operation.phase !== 'destructive') throw new Error('Firmware write authorization was not created.');
      return { operation: result.operation, writeToken };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Firmware write authorization failed.');
}

function randomWriteToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function reportVerifiedFirmwareWrite(
  token: string | undefined,
  operation: DeviceBridgeOperationPublic,
  writeToken: string,
  outcome: 'completed' | 'failed',
): Promise<DeviceBridgeOperationPublic> {
  const requestId = crypto.randomUUID();
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await request<DeviceBridgeProbeResponse>(
        `/Roadex/api/device-bridge/operations/${encodeURIComponent(operation.id)}/report`,
        { method: 'POST', token, body: { artifactSha256: operation.artifactSha256, outcome, writeToken }, requestId },
      );
      if (!result.ok) throw new Error(result.reason);
      return result.operation;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Firmware write report failed.');
}

export async function cancelSession(token: string | undefined, sessionId: string): Promise<CancelResponse> {
  return request<CancelResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/cancel`, {
    method: 'POST',
    token,
  });
}

export async function closeSession(token: string | undefined, sessionId: string): Promise<CloseResponse> {
  return request<CloseResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/close`, {
    method: 'POST',
    token,
  });
}

export async function listArchivedSessions(token: string | undefined): Promise<ArchivedSessionsResponse> {
  return request<ArchivedSessionsResponse>('/api/sessions', { token });
}

export async function reopenSession(
  token: string | undefined,
  sessionId: string,
): Promise<Extract<ReopenResponse, { reopened: true }>> {
  const response = await request<ReopenResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/reopen`, {
    method: 'POST',
    token,
  });
  if (!response.reopened) {
    throw new Error(response.reason);
  }
  return response;
}

export async function readSessionStream(token: string | undefined, sessionId: string): Promise<StreamEvent[]> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/stream`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Stream request failed with status ${response.status}`);
  }

  const raw = await response.text();
  return raw
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => chunk.split('\n').find((line) => line.startsWith('data: ')))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice(6)) as StreamEvent);
}

export function subscribeSessionStream(
  token: string | undefined,
  sessionId: string,
  onEvent: (event: StreamEvent) => void,
  onError: (error: Error) => void,
): () => void {
  const controller = new AbortController();
  void readLiveSessionStream(token, sessionId, onEvent, controller.signal).catch((error: unknown) => {
    if (!controller.signal.aborted) {
      onError(error instanceof Error ? error : new Error('Live stream failed.'));
    }
  });
  return () => controller.abort();
}

async function readLiveSessionStream(
  token: string | undefined,
  sessionId: string,
  onEvent: (event: StreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/stream?live=1`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Live stream request failed with status ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      const data = chunk
        .split('\n')
        .find((line) => line.startsWith('data: '));
      if (data) {
        onEvent(JSON.parse(data.slice(6)) as StreamEvent);
      }
    }
  }
}

type RequestOptions = {
  method?: string;
  token?: string;
  body?: unknown;
  requestId?: string;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const response = await fetch(path, {
    method,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(method !== 'GET' && csrfToken ? { 'x-roadex-csrf': csrfToken } : {}),
      ...(options.requestId ? { 'x-roadex-request-id': options.requestId } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const refreshedCsrfToken = response.headers.get('x-roadex-csrf');
  if (refreshedCsrfToken) csrfToken = refreshedCsrfToken;

  const payload = (await response.json()) as T | ApiError;
  if (!response.ok || isApiError(payload)) {
    if (response.status === 409 && !isApiError(payload)) {
      return payload as T;
    }
    const message = isApiError(payload) ? payload.error.message : `Request failed with status ${response.status}`;
    throw new Error(message);
  }

  return payload;
}

async function requestOptional<T>(path: string, options: RequestOptions = {}): Promise<
  | {
      ok: true;
      payload: T;
    }
  | {
      ok: false;
    }
> {
  try {
    return {
      ok: true,
      payload: await request<T>(path, options),
    };
  } catch {
    return { ok: false };
  }
}
