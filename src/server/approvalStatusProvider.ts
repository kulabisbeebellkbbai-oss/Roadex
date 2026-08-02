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
  fetchJson?: (path: string, token: string, signal: AbortSignal) => Promise<unknown>;
};

type ProviderErrorCode =
  | 'approval_status:api_base_not_permitted'
  | 'approval_status:token_read_failed'
  | 'approval_status:token_invalid'
  | 'approval_status:request_timeout'
  | 'approval_status:request_failed'
  | 'approval_status:invalid_content_length'
  | 'approval_status:response_oversized'
  | 'approval_status:empty_response'
  | 'approval_status:invalid_payload'
  | 'approval_status:scope_mismatch';

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
const ISO8601_WITH_TZ_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const CONTENT_LENGTH_PATTERN = /^(?:0|[1-9]\d*)$/;
export function createOverseerApprovalStatusProvider(options: OverseerProviderOptions): ApprovalStatusProvider {
  const apiBase = options.apiBase ?? OVERSEER_API_BASE;
  if (apiBase !== OVERSEER_API_BASE) {
    throw providerError('approval_status:api_base_not_permitted', API_BASE_ERROR_MARKER);
  }

  const configuredFetchJson = options.fetchJson;

  return {
    getStatus: async (approvalRef, scope) => {
      const requestMarker = {};
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
        throw providerError('approval_status:token_read_failed', requestMarker);
      }
      try {
        token = validateBearerToken(token);
      } catch {
        throw providerError('approval_status:token_invalid', requestMarker);
      }

      const encodedRef = encodeURIComponent(canonical.approvalRef);
      const path = `${APPROVER_STATUS_PATH_PREFIX}${encodedRef}`;

      let payload: unknown;
      try {
        payload = await withTimeout((signal) => {
          if (configuredFetchJson === undefined) {
            return defaultFetchJson(apiBase, path, token, signal, requestMarker);
          }
          return configuredFetchJson(path, token, signal);
        }, requestMarker);
      } catch (_error) {
        throw normalizeReadError(_error, requestMarker);
      }

      let projection: RoadexApprovalStatusProjection;
      try {
        projection = parseRoadexApprovalStatusProjection(payload);
      } catch {
        throw providerError('approval_status:invalid_payload', requestMarker);
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
        throw providerError('approval_status:scope_mismatch', requestMarker);
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

function normalizeReadError(error: unknown, requestMarker: object): Error {
  if (isApprovalStatusProviderError(error, requestMarker)) {
    return error;
  }
  return providerError('approval_status:request_failed', requestMarker);
}

async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, requestMarker: object): Promise<T> {
  const controller = new AbortController();
  let operationSettled = false;
  let timeoutSettled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutError = providerError('approval_status:request_timeout', requestMarker);
  const requestFailedError = providerError('approval_status:request_failed', requestMarker);
  type RaceResult = { kind: 'success'; value: T } | { kind: 'timeout' } | { kind: 'failure'; error: unknown };

  const wrappedOperation = Promise.resolve()
    .then(() => operation(controller.signal))
    .then(
      (value): RaceResult => ({ kind: 'success', value }),
      (error): RaceResult => ({ kind: 'failure', error }),
    );

  const timeoutPromise = new Promise<RaceResult>((resolve) => {
    timer = setTimeout(() => {
      if (operationSettled) {
        return;
      }
      operationSettled = true;
      timeoutSettled = true;
      controller.abort(new DOMException('Overseer approval status request timed out.', 'TimeoutError'));
      resolve({ kind: 'timeout' });
    }, DEFAULT_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([wrappedOperation, timeoutPromise]);

    if (result.kind === 'timeout') {
      throw timeoutError;
    }

    operationSettled = true;
    if (result.kind === 'failure') {
      if (isApprovalStatusProviderError(result.error, requestMarker)) {
        throw result.error;
      }
      throw requestFailedError;
    }

    if (result.kind === 'success') {
      return result.value;
    }

    throw requestFailedError;
  } catch (error) {
    if (timeoutSettled) {
      throw timeoutError;
    }
    if (isApprovalStatusProviderError(error, requestMarker)) {
      throw error;
    }
    throw requestFailedError;
  } finally {
    operationSettled = true;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function defaultFetchJson(
  apiBase: string,
  path: string,
  token: string,
  signal: AbortSignal,
  requestMarker: object,
): Promise<unknown> {
  const response = await fetch(`${apiBase}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    cache: 'no-store',
    signal,
  });

  if (!response.ok) {
    throw providerError('approval_status:request_failed', requestMarker);
  }

  const declaredLength = parseDeclaredLength(response.headers.get('content-length'), requestMarker);

  if (!response.body) {
    throw providerError('approval_status:empty_response', requestMarker);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    if (value === undefined) {
      continue;
    }

    if (value.byteLength === 0) {
      continue;
    }

    totalBytes += value.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // best-effort cancellation; size policy takes precedence.
      }
      throw providerError('approval_status:response_oversized', requestMarker);
    }

    chunks.push(value);
  }

  const body = concatUint8Arrays(chunks, totalBytes);
  if (body.byteLength === 0) {
    throw providerError('approval_status:empty_response', requestMarker);
  }
  if (declaredLength !== undefined && declaredLength !== body.byteLength) {
    throw providerError('approval_status:invalid_content_length', requestMarker);
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', {
      fatal: true,
    }).decode(body);
  } catch {
    throw providerError('approval_status:invalid_payload', requestMarker);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw providerError('approval_status:invalid_payload', requestMarker);
  }
}

function parseDeclaredLength(value: string | null, requestMarker: object): number | undefined {
  if (value === null) {
    return undefined;
  }
  if (!CONTENT_LENGTH_PATTERN.test(value)) {
    throw providerError('approval_status:invalid_content_length', requestMarker);
  }

  const declaredLength = Number(value);
  if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
    throw providerError('approval_status:invalid_content_length', requestMarker);
  }
  if (declaredLength > MAX_RESPONSE_BYTES) {
    throw providerError('approval_status:response_oversized', requestMarker);
  }

  return declaredLength;
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
  if (keys.length !== APPROVAL_PROJECTION_REQUIRED_KEYS.length) {
    throw new Error('Approval status has unexpected shape.');
  }

  for (const key of keys) {
    if (typeof key !== 'string') {
      throw new Error('Approval status has non-string keys.');
    }
    if (!APPROVAL_PROJECTION_REQUIRED_KEY_SET.has(key)) {
      throw new Error('Approval status has unexpected field.');
    }
  }

  const values = Object.create(null) as Record<string, unknown>;
  for (const key of APPROVAL_PROJECTION_REQUIRED_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || descriptor.enumerable === false
      || descriptor.get !== undefined
      || descriptor.set !== undefined
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      throw new Error('Approval status has non-enumerable field.');
    }
    values[key] = descriptor.value;
  }

  const candidate = values;
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

function parseSha256Digest(value: unknown): string {
  if (!isCanonicalOpaque(value, 64 + 'sha256:'.length) || !SHA256_HEX_PATTERN.test(value)) {
    throw new Error('Approval status has invalid values.');
  }

  return value;
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

function parseOpaqueString(value: unknown, maxLength: number): string {
  if (!isCanonicalOpaque(value, maxLength)) {
    throw new Error('Approval status has invalid values.');
  }

  return value;
}

class ProviderFailure extends Error {
  readonly code: ProviderErrorCode;

  constructor(code: ProviderErrorCode) {
    super(code);
    this.code = code;
  }
}

const API_BASE_ERROR_MARKER = Object.freeze({});
const providerErrorMarkers = new WeakMap<object, object>();

type ApprovalStatusProviderError = ProviderFailure;

function isApprovalStatusProviderError(error: unknown, requestMarker: object): error is ApprovalStatusProviderError {
  if (error === null || typeof error !== 'object') {
    return false;
  }

  return providerErrorMarkers.get(error) === requestMarker;
}

function providerError(code: ProviderErrorCode, requestMarker: object): ApprovalStatusProviderError {
  const error = new ProviderFailure(code);
  providerErrorMarkers.set(error, requestMarker);
  return error;
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

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    fractionText,
    timeZoneText,
    timeZoneSignText,
    tzHourText,
    tzMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const fraction = fractionText ?? '';
  const tzSign = timeZoneText === 'Z' ? 'Z' : timeZoneSignText;
  const tzHour = timeZoneText === 'Z' || tzSign === undefined ? 0 : Number(tzHourText);
  const tzMinute = timeZoneText === 'Z' || tzSign === undefined ? 0 : Number(tzMinuteText);

  if (month < 1 || month > 12) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;

  const maxDay = daysInMonth(year, month);
  if (day < 1 || day > maxDay) return false;

  const tzOffsetMinutes = tzSign === 'Z' ? 0 : parseOffsetMinutes(tzSign, tzHour, tzMinute);
  if (tzOffsetMinutes === null) return false;

  const fractionValue = fraction.length === 0 ? 0 : Number(fraction.padEnd(6, '0').slice(0, 6));
  const utcMinutes = Date.UTC(year, month - 1, day, hour, minute, second, fractionValue) - tzOffsetMinutes * 60_000;
  return Number.isFinite(utcMinutes);
}

function parseOffsetMinutes(sign: string, hour: number, minute: number): number | null {
  if (hour < 0 || hour > 14) return null;
  if (minute < 0 || minute > 59) return null;
  if (hour === 14 && minute !== 0) return null;

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
