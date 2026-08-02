import {
  type ApprovalAuthorityClass,
  type ApprovalDecision,
  type NormalizedApprovalStatus,
  type RoadexApprovalStatusProjection,
} from '../shared/approvalWorkflowContracts.js';

export type ApprovalScope = {
  projectId: string;
  workspaceId: string;
  resourceRef: string;
};

export type ApprovalStatusProvider = {
  getStatus: (approvalRef: string, scope: ApprovalScope) => Promise<NormalizedApprovalStatus>;
};

export type OverseerProviderOptions = {
  apiBase?: 'http://127.0.0.1:8766';
  readToken: () => string;
  fetchJson?: (path: string, token: string) => Promise<unknown>;
};

const OVERSEER_API_BASE = 'http://127.0.0.1:8766' as const;
const APPROVER_STATUS_PATH_PREFIX = '/roadex/approval-status?approval_ref=';
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 32_768;
const MAX_APPROVAL_REF_LENGTH = 256;
const MAX_SCOPE_FIELD_LENGTH = 256;
const MAX_TEXT_FIELD_LENGTH = 256;
const MAX_TOKEN_LENGTH = 256;

const APPROVAL_DECISIONS = new Set<ApprovalDecision>([
  'pending',
  'approved',
  'changes-requested',
  'rejected',
  'expired',
  'revoked',
]);
const APPROVAL_PROJECTION_REQUIRED_KEYS = [
  'approvalRef',
  'sourceKind',
  'projectId',
  'workspaceId',
  'resourceRef',
  'authorityClass',
  'subject',
  'scopeDigest',
  'decision',
  'decisionVersion',
  'updatedAt',
];
const APPROVAL_PROJECTION_REQUIRED_KEY_SET = new Set(APPROVAL_PROJECTION_REQUIRED_KEYS);
const SHA256_HEX_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ISO8601_WITH_TZ_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):?(\d{2}))$/;
const CONTENT_LENGTH_PATTERN = /^\d+$/;

export function createOverseerApprovalStatusProvider(options: OverseerProviderOptions): ApprovalStatusProvider {
  const apiBase = options.apiBase ?? OVERSEER_API_BASE;
  const fetchJson = options.fetchJson ?? ((path: string, token: string, signal: AbortSignal) => defaultFetchJson(apiBase, path, token, signal));

  return {
    getStatus: async (approvalRef, scope) => {
      const canonical = {
        approvalRef: validateCanonicalOpaque('approvalRef', approvalRef, MAX_APPROVAL_REF_LENGTH),
        projectId: validateCanonicalOpaque('projectId', scope.projectId, MAX_SCOPE_FIELD_LENGTH),
        workspaceId: validateCanonicalOpaque('workspaceId', scope.workspaceId, MAX_SCOPE_FIELD_LENGTH),
        resourceRef: validateCanonicalOpaque('resourceRef', scope.resourceRef, MAX_SCOPE_FIELD_LENGTH),
      };

      let token: string;
      try {
        token = options.readToken();
      } catch {
        throw providerError('Failed to read overseer token.');
      }
      try {
        token = validateBearerToken(token);
      } catch {
        throw providerError('Invalid overseer token.');
      }

      if (apiBase !== OVERSEER_API_BASE) {
        throw providerError('Overseer API base is not permitted.');
      }

      const encodedRef = encodeURIComponent(canonical.approvalRef);
      const path = `${APPROVER_STATUS_PATH_PREFIX}${encodedRef}`;

      let payload: unknown;
      try {
        payload = await withTimeout((signal) => (options.fetchJson ? options.fetchJson(path, token) : fetchJson(path, token, signal)));
      } catch (_error) {
        throw providerError(categorizeReadError(_error));
      }

      let projection: RoadexApprovalStatusProjection;
      try {
        projection = parseRoadexApprovalStatusProjection(payload);
      } catch {
        throw providerError('Invalid approval status payload.');
      }

      const scopeMatches = {
        approvalRef: constantTimeEqual(canonical.approvalRef, projection.approvalRef),
        projectId: constantTimeEqual(canonical.projectId, projection.projectId),
        workspaceId: constantTimeEqual(canonical.workspaceId, projection.workspaceId),
        resourceRef: constantTimeEqual(canonical.resourceRef, projection.resourceRef),
      };

      if (
        !scopeMatches.approvalRef
        || !scopeMatches.projectId
        || !scopeMatches.workspaceId
        || !scopeMatches.resourceRef
      ) {
        throw providerError('Approval status does not match expected scope.');
      }

      return {
        provider: 'overseer',
        approvalRef: projection.approvalRef,
        authorityClass: projection.authorityClass,
        decision: projection.decision,
        decisionVersion: projection.decisionVersion,
        projectId: projection.projectId,
        workspaceId: projection.workspaceId,
        resourceRef: projection.resourceRef,
        subject: projection.subject,
        updatedAt: projection.updatedAt,
      };
    },
  };
}

async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new DOMException('Overseer approval status request timed out.', 'TimeoutError'));
      reject(new Error('Overseer approval status request timed out.'));
    }, DEFAULT_TIMEOUT_MS);

    const clear = () => clearTimeout(timer);

    operation(controller.signal).then(
      (result) => {
        clear();
        resolve(result);
      },
      (error) => {
        clear();
        reject(error);
      },
    );
  });
}

async function defaultFetchJson(apiBase: string, path: string, token: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(`${apiBase}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    cache: 'no-store',
    signal,
  });

  if (!response.ok) {
    throw new Error(`Overseer approval status request failed with HTTP ${String(response.status)}`);
  }

  const declaredLengthHeader = response.headers.get('content-length');
  const declaredLength = parseDeclaredLength(declaredLengthHeader);
  if (declaredLength === undefined) {
    // nothing to validate
  } else if (declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error('Overseer approval status response is oversized.');
  }

  if (!response.body) {
    throw new Error('Overseer approval status response has no body.');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    if (declaredLength !== undefined && totalBytes + value.byteLength > declaredLength) {
      await reader.cancel();
      throw new Error('Overseer approval status response is oversized.');
    }
    totalBytes += value.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('Overseer approval status response is oversized.');
    }
    chunks.push(value);
  }

  const body = concatUint8Arrays(chunks, totalBytes);
  const text = new TextDecoder().decode(body);

  return JSON.parse(text);
}

function parseDeclaredLength(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  if (!CONTENT_LENGTH_PATTERN.test(value)) {
    throw new Error('Invalid content-length.');
  }

  return Number(value);
}

function concatUint8Arrays(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  if (chunks.length === 0) {
    return new Uint8Array(0);
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}

function parseRoadexApprovalStatusProjection(value: unknown): RoadexApprovalStatusProjection {
  if (!isRecord(value)) {
    throw new Error('Approval status is not an object.');
  }

  const keys = Reflect.ownKeys(value);
  if (keys.length !== APPROVAL_PROJECTION_REQUIRED_KEY_SET.size) {
    throw new Error('Approval status has unexpected shape.');
  }
  for (const key of keys) {
    if (typeof key !== 'string') {
      throw new Error('Approval status has non-string keys.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable) {
      throw new Error('Approval status has non-enumerable field.');
    }
    if (!APPROVAL_PROJECTION_REQUIRED_KEY_SET.has(key)) {
      throw new Error('Approval status has unexpected field.');
    }
  }
  for (const requiredKey of APPROVAL_PROJECTION_REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, requiredKey)) {
      throw new Error('Approval status is missing required fields.');
    }
  }

  const candidate = value as Record<string, unknown>;
  const sourceKind = parseSourceKind(candidate.sourceKind);
  const authorityClass = parseApprovalAuthorityClass(candidate.authorityClass);
  const decision = parseApprovalDecision(candidate.decision);
  const approvalRef = parseOpaqueString(candidate.approvalRef, MAX_APPROVAL_REF_LENGTH);
  const projectId = parseOpaqueString(candidate.projectId, MAX_SCOPE_FIELD_LENGTH);
  const workspaceId = parseOpaqueString(candidate.workspaceId, MAX_SCOPE_FIELD_LENGTH);
  const resourceRef = parseOpaqueString(candidate.resourceRef, MAX_SCOPE_FIELD_LENGTH);
  const subject = parseOpaqueString(candidate.subject, MAX_TEXT_FIELD_LENGTH);
  const scopeDigest = parseSha256Digest(candidate.scopeDigest);
  const decisionVersion = parseSha256Digest(candidate.decisionVersion);
  const updatedAt = parseOpaqueString(candidate.updatedAt, MAX_TEXT_FIELD_LENGTH);

  if (!isValidIso(updatedAt)) {
    throw new Error('Approval status has invalid values.');
  }

  return {
    approvalRef,
    sourceKind,
    projectId,
    workspaceId,
    resourceRef,
    authorityClass,
    subject,
    scopeDigest,
    decision,
    decisionVersion,
    updatedAt,
  } as RoadexApprovalStatusProjection;
}

function parseSourceKind(value: unknown): RoadexApprovalStatusProjection['sourceKind'] {
  if (!isApprovalSourceKind(value)) {
    throw new Error('Approval status has unsupported source kind.');
  }

  return value;
}

function parseApprovalAuthorityClass(value: unknown): ApprovalAuthorityClass {
  if (!isApprovalAuthorityClass(value)) {
    throw new Error('Approval status has unsupported authority class.');
  }

  return value;
}

function parseApprovalDecision(value: unknown): ApprovalDecision {
  if (!isApprovalDecision(value) || !isCanonicalOpaque(value, MAX_TEXT_FIELD_LENGTH)) {
    throw new Error('Approval status has invalid values.');
  }

  return value;
}

function parseSha256Digest(value: unknown): string {
  const digest = parseOpaqueString(value, 71);
  if (!SHA256_HEX_PATTERN.test(digest)) {
    throw new Error('Approval status has invalid values.');
  }

  return digest;
}

function isApprovalSourceKind(value: unknown): value is RoadexApprovalStatusProjection['sourceKind'] {
  return value === 'admin-plan' || value === 'roadex-human-decision';
}

function isApprovalAuthorityClass(value: unknown): value is ApprovalAuthorityClass {
  return value === 'privileged-operation' || value === 'project-workflow';
}

function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return (
    typeof value === 'string'
    && APPROVAL_DECISIONS.has(value as ApprovalDecision)
  );
}

function parseOpaqueString(value: unknown, maxLength: number): string {
  if (!isCanonicalOpaque(value, maxLength)) {
    throw new Error('Approval status has invalid values.');
  }

  return value;
}

function providerError(message: string): Error {
  return new Error(message);
}

function parseValidation<T>(value: unknown, maxLength: number, field: string): T {
  if (!isCanonicalOpaqueString(value, maxLength)) {
    throw new Error(`Invalid ${field}.`);
  }

  return value as T;
}

function validateCanonicalOpaque(name: string, value: unknown, maxLength: number): string {
  return parseValidation<string>(value, maxLength, name);
}

function validateBearerToken(value: unknown): string {
  if (!isCanonicalOpaqueString(value, MAX_TOKEN_LENGTH)) {
    throw new Error('Invalid overseer token.');
  }

  if (value.startsWith('Bearer ')) {
    throw new Error('Invalid overseer token.');
  }

  return value;
}

function isCanonicalOpaqueString(value: unknown, maxLength: number): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > maxLength) return false;
  if (value.trim() !== value) return false;

  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 0x1f || (0x7f <= codePoint && codePoint <= 0x9f)) return false;
  }

  return true;
}

function isCanonicalOpaque(value: unknown, maxLength: number): value is string {
  return isCanonicalOpaqueString(value, maxLength);
}

function isValidIso(value: string): boolean {
  const match = ISO8601_WITH_TZ_PATTERN.exec(value);
  if (match === null) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? '';
  const tzSign = match[9] === undefined ? 'Z' : match[9];
  const tzHour = match[10] === undefined ? 0 : Number(match[10]);
  const tzMinute = match[11] === undefined ? 0 : Number(match[11]);

  if (month < 1 || month > 12) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (tzSign === undefined && match[8] === undefined) return false;

  const maxDay = daysInMonth(year, month);
  if (day < 1 || day > maxDay) return false;

  const tzOffsetMinutes = tzSign === 'Z' ? 0 : parseOffsetMinutes(tzSign, tzHour, tzMinute);
  if (tzOffsetMinutes === null) return false;

  const fractionValue = fraction.length === 0 ? 0 : Number(fraction.padEnd(6, '0').slice(0, 3));
  const utcMinutes = Date.UTC(year, month - 1, day, hour, minute, second, fractionValue) - tzOffsetMinutes * 60_000;
  return Number.isFinite(utcMinutes);
}

function parseOffsetMinutes(sign: string, hour: number, minute: number): number | null {
  if (sign === 'Z') {
    return 0;
  }

  if (hour > 23 || minute > 59) return null;

  const offsetMinutes = hour * 60 + minute;
  return sign === '+' ? offsetMinutes : -offsetMinutes;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = isLeapYear(year);
    return leap ? 29 : 28;
  }

  if (month === 4 || month === 6 || month === 9 || month === 11) {
    return 30;
  }

  return 31;
}

function isLeapYear(year: number): boolean {
  if (year % 4 !== 0) return false;
  if (year % 100 !== 0) return true;
  return year % 400 === 0;
}

function constantTimeEqual(left: string, right: string): boolean {
  const maxLength = Math.max(left.length, right.length);
  let delta = left.length ^ right.length;

  for (let index = 0; index < maxLength; index += 1) {
    const leftCode = index < left.length ? left.charCodeAt(index) : 0;
    const rightCode = index < right.length ? right.charCodeAt(index) : 0;
    delta |= leftCode ^ rightCode;
  }

  return delta === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function categorizeReadError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message === 'Invalid content-length.') {
    return 'Invalid content-length.';
  }
  if (message.includes('timed out')) {
    return message;
  }
  if (message === 'Overseer approval status response is oversized.') {
    return 'Overseer approval status response is oversized.';
  }
  if (message === 'Overseer approval status response has no body.') {
    return 'Overseer approval status response has no body.';
  }
  return 'Failed to read exact approval status.';
}
