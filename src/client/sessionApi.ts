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
import { isApiError, isPromptApprovalPendingResponse } from '../shared/apiContracts';
import type {
  ProjectCreationChallengeResponse,
  ProjectCreationConfirmPayload,
  ProjectCreationProposalPayload,
  ProjectCreationProposalPublic,
  ProjectCreationProposalResponse,
} from '../shared/projectCreationContracts';
import type {
  AppPublicationRequestPublic,
  AppPublicationRequestResponse,
  AppPublicationRequestSpec,
} from '../shared/appPublicationContracts';
import type { ProjectHumanThreadBinding } from '../shared/projectHumanThreadContracts';

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
    acceptErrorResponse: (status, payload): payload is PromptResponse => (
      status === 409 && isPromptApprovalPendingResponse(payload)
    ),
  });
}

export async function createProjectProposal(
  token: string | undefined,
  body: ProjectCreationProposalPayload,
): Promise<ProjectCreationProposalPublic> {
  const response = await request<ProjectCreationProposalResponse>('/Roadex/api/project-creation/proposals', {
    method: 'POST',
    token,
    body,
    requestId: crypto.randomUUID(),
  });
  return response.proposal;
}

export async function requestProjectConfirmation(
  token: string | undefined,
  proposalId: string,
): Promise<ProjectCreationChallengeResponse['challenge']> {
  const response = await request<ProjectCreationChallengeResponse>(
    `/Roadex/api/project-creation/proposals/${encodeURIComponent(proposalId)}/challenge`,
    { method: 'POST', token, body: {}, requestId: crypto.randomUUID() },
  );
  return response.challenge;
}

export async function confirmProjectProposal(
  token: string | undefined,
  proposalId: string,
  body: ProjectCreationConfirmPayload,
): Promise<ProjectCreationProposalPublic> {
  const response = await request<ProjectCreationProposalResponse>(
    `/Roadex/api/project-creation/proposals/${encodeURIComponent(proposalId)}/confirm`,
    { method: 'POST', token, body, requestId: crypto.randomUUID() },
  );
  return response.proposal;
}

export async function revokeProjectProposal(
  token: string | undefined,
  proposalId: string,
): Promise<ProjectCreationProposalPublic> {
  const response = await request<ProjectCreationProposalResponse>(
    `/Roadex/api/project-creation/proposals/${encodeURIComponent(proposalId)}/revoke`,
    { method: 'POST', token, body: {}, requestId: crypto.randomUUID() },
  );
  return response.proposal;
}

export async function createAppPublicationRequest(
  token: string | undefined,
  spec: AppPublicationRequestSpec,
  idempotencyKey: string,
): Promise<AppPublicationRequestPublic> {
  const response = await request<AppPublicationRequestResponse>(
    '/Roadex/api/app-publication/requests',
    {
      method: 'POST',
      token,
      body: spec,
      requestId: crypto.randomUUID(),
      headers: { 'idempotency-key': idempotencyKey },
    },
  );
  return response.request;
}

export async function getAppPublicationRequest(
  token: string | undefined,
  requestId: string,
): Promise<AppPublicationRequestPublic> {
  const response = await request<AppPublicationRequestResponse>(
    `/Roadex/api/app-publication/requests/${encodeURIComponent(requestId)}`,
    { token },
  );
  return response.request;
}

export type ProjectHumanThreadCandidatePublic = {
  conversationId: string;
  canonicalPath: string;
  dev: string;
  ino: string;
  createdAt: number;
};
export type ProjectHumanThreadReplacementPublic = {
  expectedGeneration: number;
  reason: string;
  createPhase: 'not-started' | 'creating' | 'reconcile-required' | 'created';
  createdConversationId?: string;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

const projectHumanThreadIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const projectHumanThreadUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const projectHumanThreadDigestPattern = /^[a-f0-9]{64}$/;
const projectHumanThreadTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isProjectHumanThreadCandidate(value: unknown): value is ProjectHumanThreadCandidatePublic {
  if (!isPlainRecord(value)) return false;
  const candidate = value;
  return hasExactKeys(candidate, ['canonicalPath', 'conversationId', 'createdAt', 'dev', 'ino'])
    && typeof candidate.conversationId === 'string'
    && projectHumanThreadUuidPattern.test(candidate.conversationId)
    && typeof candidate.canonicalPath === 'string'
    && candidate.canonicalPath.startsWith('/')
    && candidate.canonicalPath === candidate.canonicalPath.trim()
    && typeof candidate.dev === 'string'
    && /^(?:0|[1-9][0-9]{0,19})$/.test(candidate.dev)
    && typeof candidate.ino === 'string'
    && /^[1-9][0-9]{0,19}$/.test(candidate.ino)
    && typeof candidate.createdAt === 'number'
    && Number.isFinite(candidate.createdAt)
    && candidate.createdAt >= 0;
}

function isProjectHumanThreadRoot(value: unknown): boolean {
  return isPlainRecord(value)
    && hasExactKeys(value, ['canonicalPath', 'dev', 'ino'])
    && typeof value.canonicalPath === 'string'
    && value.canonicalPath.startsWith('/')
    && value.canonicalPath === value.canonicalPath.trim()
    && typeof value.dev === 'string'
    && /^(?:0|[1-9][0-9]{0,19})$/.test(value.dev)
    && typeof value.ino === 'string'
    && /^[1-9][0-9]{0,19}$/.test(value.ino);
}

function isProjectHumanThreadBinding(value: unknown): value is ProjectHumanThreadBinding {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'schemaVersion', 'bindingId', 'projectId', 'root', 'purpose', 'conversationId', 'generation',
    'status', 'predecessorGeneration', 'creationMode', 'provenanceDigest', 'createdAt', 'updatedAt',
    'retiredAt', 'recordDigest',
  ])) return false;
  const status = value.status;
  const generation = value.generation;
  const predecessorGeneration = value.predecessorGeneration;
  const retiredAt = value.retiredAt;
  return value.schemaVersion === 'roadex.project-human-thread-binding.v1'
    && typeof value.bindingId === 'string'
    && projectHumanThreadIdPattern.test(value.bindingId)
    && typeof value.projectId === 'string'
    && projectHumanThreadIdPattern.test(value.projectId)
    && value.bindingId === `project-human-thread:${value.projectId}:${generation}`
    && isProjectHumanThreadRoot(value.root)
    && value.purpose === 'human-interaction'
    && typeof value.conversationId === 'string'
    && projectHumanThreadUuidPattern.test(value.conversationId)
    && typeof generation === 'number'
    && Number.isInteger(generation)
    && generation > 0
    && ['active', 'unavailable', 'replacement-pending', 'retired'].includes(String(status))
    && (generation === 1 ? predecessorGeneration === null : predecessorGeneration === generation - 1)
    && ['created', 'adopted'].includes(String(value.creationMode))
    && typeof value.provenanceDigest === 'string'
    && projectHumanThreadDigestPattern.test(value.provenanceDigest)
    && typeof value.recordDigest === 'string'
    && projectHumanThreadDigestPattern.test(value.recordDigest)
    && typeof value.createdAt === 'string'
    && projectHumanThreadTimestampPattern.test(value.createdAt)
    && Number.isFinite(Date.parse(value.createdAt))
    && typeof value.updatedAt === 'string'
    && projectHumanThreadTimestampPattern.test(value.updatedAt)
    && Number.isFinite(Date.parse(value.updatedAt))
    && Date.parse(value.updatedAt) >= Date.parse(value.createdAt)
    && (retiredAt === null || (typeof retiredAt === 'string' && projectHumanThreadTimestampPattern.test(retiredAt)))
    && (retiredAt === null || (Number.isFinite(Date.parse(retiredAt)) && Date.parse(retiredAt) >= Date.parse(value.createdAt)))
    && (status === 'retired') === (retiredAt !== null);
}

function isProjectHumanThreadReplacement(value: unknown): value is ProjectHumanThreadReplacementPublic {
  if (!isPlainRecord(value) || !hasExactKeys(
    value,
    ['expectedGeneration', 'reason', 'createPhase'],
    ['createdConversationId'],
  )) return false;
  return typeof value.expectedGeneration === 'number'
    && Number.isInteger(value.expectedGeneration)
    && value.expectedGeneration > 0
    && typeof value.reason === 'string'
    && value.reason.length > 0
    && value.reason.length <= 1_000
    && value.reason === value.reason.trim()
    && ['not-started', 'creating', 'reconcile-required', 'created'].includes(String(value.createPhase))
    && (value.createdConversationId === undefined
      || (typeof value.createdConversationId === 'string' && projectHumanThreadUuidPattern.test(value.createdConversationId)));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hasValidProjectHumanThreadResponse(
  value: unknown,
  expectedProjectId: string,
  expectedProjectRoot: string,
): Promise<boolean> {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['ok', 'requestedProjectId', 'canonicalProjectId', 'candidates'], ['current', 'replacement'])) return false;
  const response = value;
  if (response.ok !== true
    || response.requestedProjectId !== expectedProjectId
    || typeof response.canonicalProjectId !== 'string'
    || !projectHumanThreadIdPattern.test(response.canonicalProjectId)
    || !Array.isArray(response.candidates)
    || !response.candidates.every(isProjectHumanThreadCandidate)
    || response.candidates.some((candidate) => candidate.canonicalPath !== expectedProjectRoot)
    || (response.current !== undefined && !isProjectHumanThreadBinding(response.current))
    || (response.replacement !== undefined && !isProjectHumanThreadReplacement(response.replacement))) return false;

  const current = response.current as ProjectHumanThreadBinding | undefined;
  const replacement = response.replacement as ProjectHumanThreadReplacementPublic | undefined;
  if (current) {
    if (current.status === 'retired') return false;
    if (current.projectId !== response.canonicalProjectId || current.root.canonicalPath !== expectedProjectRoot) return false;
    const { recordDigest, ...bindingWithoutDigest } = current;
    if (await sha256(canonicalJson(bindingWithoutDigest)) !== recordDigest) return false;
    if (current.status !== 'replacement-pending' && (response.candidates.length > 0 || replacement)) return false;
  } else if (replacement || response.canonicalProjectId !== expectedProjectId) {
    return false;
  }
  if (replacement && replacement.expectedGeneration !== current?.generation) return false;
  if (replacement?.createPhase === 'created' && !replacement.createdConversationId) return false;
  if (replacement?.createPhase !== 'created' && replacement?.createdConversationId) return false;
  return true;
}

function isProjectHumanThreadHistoryBinding(value: unknown, expectedProjectId: string): boolean {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'schemaVersion', 'bindingId', 'projectId', 'purpose', 'conversationId', 'generation', 'status',
    'predecessorGeneration', 'creationMode', 'createdAt', 'updatedAt', 'retiredAt', 'recordDigest',
  ])) return false;
  const generation = value.generation;
  const retiredAt = value.retiredAt;
  return value.schemaVersion === 'roadex.project-human-thread-binding.v1'
    && value.projectId === expectedProjectId
    && typeof generation === 'number'
    && Number.isInteger(generation)
    && generation > 0
    && value.bindingId === `project-human-thread:${expectedProjectId}:${generation}`
    && value.purpose === 'human-interaction'
    && typeof value.conversationId === 'string'
    && projectHumanThreadUuidPattern.test(value.conversationId)
    && ['active', 'unavailable', 'replacement-pending', 'retired'].includes(String(value.status))
    && (generation === 1 ? value.predecessorGeneration === null : value.predecessorGeneration === generation - 1)
    && ['created', 'adopted'].includes(String(value.creationMode))
    && typeof value.createdAt === 'string'
    && projectHumanThreadTimestampPattern.test(value.createdAt)
    && Number.isFinite(Date.parse(value.createdAt))
    && typeof value.updatedAt === 'string'
    && projectHumanThreadTimestampPattern.test(value.updatedAt)
    && Number.isFinite(Date.parse(value.updatedAt))
    && Date.parse(value.updatedAt) >= Date.parse(value.createdAt)
    && (retiredAt === null || (typeof retiredAt === 'string'
      && projectHumanThreadTimestampPattern.test(retiredAt)
      && Number.isFinite(Date.parse(retiredAt))
      && Date.parse(retiredAt) >= Date.parse(value.createdAt)))
    && (value.status === 'retired') === (retiredAt !== null)
    && typeof value.recordDigest === 'string'
    && projectHumanThreadDigestPattern.test(value.recordDigest);
}

export async function getProjectHumanThread(
  token: string | undefined,
  projectId: string,
  projectRoot: string,
): Promise<{ current?: ProjectHumanThreadBinding; candidates: ProjectHumanThreadCandidatePublic[]; replacement?: ProjectHumanThreadReplacementPublic }> {
  const response = await request<{ ok: true; requestedProjectId: string; canonicalProjectId: string; current?: ProjectHumanThreadBinding; candidates: ProjectHumanThreadCandidatePublic[]; replacement?: ProjectHumanThreadReplacementPublic }>(
    `/Roadex/api/projects/${encodeURIComponent(projectId)}/human-thread`, { token },
  );
  if (!await hasValidProjectHumanThreadResponse(response, projectId, projectRoot)) {
    throw new Error('Project human thread response is invalid.');
  }
  return { current: response.current, candidates: response.candidates, replacement: response.replacement };
}

export async function getProjectHumanThreadHistory(
  token: string | undefined,
  projectId: string,
): Promise<Array<Omit<ProjectHumanThreadBinding, 'root' | 'provenanceDigest'>>> {
  const response = await request<{ ok: true; requestedProjectId: string; canonicalProjectId: string; history: Array<Omit<ProjectHumanThreadBinding, 'root' | 'provenanceDigest'>> }>(
    `/Roadex/api/projects/${encodeURIComponent(projectId)}/human-thread/history`, { token },
  );
  if (!isPlainRecord(response)
    || !hasExactKeys(response, ['ok', 'requestedProjectId', 'canonicalProjectId', 'history'])
    || response.ok !== true
    || response.requestedProjectId !== projectId
    || typeof response.canonicalProjectId !== 'string'
    || !projectHumanThreadIdPattern.test(response.canonicalProjectId)
    || !Array.isArray(response.history)
    || !response.history.every((binding) => isProjectHumanThreadHistoryBinding(binding, response.canonicalProjectId))
    || response.history.some((binding, index) => index > 0 && binding.generation <= response.history[index - 1]!.generation)) {
    throw new Error('Project human thread history response is invalid.');
  }
  return response.history;
}

export async function mutateProjectHumanThread(
  token: string | undefined,
  projectId: string,
  action: 'create' | 'adopt' | 'recover' | 'replace',
  idempotencyKey: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await request<{ ok: boolean; result: unknown }>(
    `/Roadex/api/projects/${encodeURIComponent(projectId)}/human-thread/${action}`,
    { method: 'POST', token, body, requestId: crypto.randomUUID(), headers: { 'idempotency-key': idempotencyKey } },
  );
  return response.result;
}

export async function resumeProjectHumanThread(
  token: string | undefined,
  projectId: string,
  expectedGeneration: number,
): Promise<unknown> {
  const response = await request<{ ok: boolean; result: unknown }>(
    `/Roadex/api/projects/${encodeURIComponent(projectId)}/human-thread/resume`,
    { method: 'POST', token, body: { expectedGeneration }, requestId: crypto.randomUUID() },
  );
  return response.result;
}

export async function reconcileProjectHumanThread(
  token: string | undefined,
  projectId: string,
  expectedGeneration: number,
  conversationId: string,
): Promise<unknown> {
  const response = await request<{ ok: boolean; result: unknown }>(
    `/Roadex/api/projects/${encodeURIComponent(projectId)}/human-thread/reconcile`,
    { method: 'POST', token, body: { expectedGeneration, conversationId }, requestId: crypto.randomUUID() },
  );
  return response.result;
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

type RequestOptions<Response> = {
  method?: string;
  token?: string;
  body?: unknown;
  requestId?: string;
  acceptErrorResponse?: (status: number, payload: unknown) => payload is Response;
  headers?: Record<string, string>;
};

export type RoadexRequestOptions<Response> = RequestOptions<Response>;

export async function requestRoadex<T>(path: string, options: RoadexRequestOptions<T> = {}): Promise<T> {
  return request<T>(path, options);
}

async function request<T>(path: string, options: RequestOptions<T> = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const response = await fetch(path, {
    method,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(method !== 'GET' && csrfToken ? { 'x-roadex-csrf': csrfToken } : {}),
      ...(options.requestId ? { 'x-roadex-request-id': options.requestId } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const refreshedCsrfToken = response.headers.get('x-roadex-csrf');
  if (refreshedCsrfToken) csrfToken = refreshedCsrfToken;

  const payload = (await response.json()) as T | ApiError;
  if (!response.ok || isApiError(payload)) {
    if (options.acceptErrorResponse?.(response.status, payload)) {
      return payload;
    }
    if (response.status === 409 && !options.acceptErrorResponse && !isApiError(payload)) {
      return payload as T;
    }
    const message = isApiError(payload) ? payload.error.message : `Request failed with status ${response.status}`;
    throw new Error(message);
  }

  return payload;
}

async function requestOptional<T>(path: string, options: RequestOptions<T> = {}): Promise<
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
