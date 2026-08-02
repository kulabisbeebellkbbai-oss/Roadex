import { type ApprovalAuthorityClass, type ApprovalDecision, type NormalizedApprovalStatus, type RoadexApprovalStatusProjection } from '../shared/approvalWorkflowContracts';

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

const APPROVAL_DECISIONS = new Set<ApprovalDecision>([
  'pending',
  'approved',
  'changes-requested',
  'rejected',
  'expired',
  'revoked',
]);

const ALLOWED_SOURCE_KINDS: ReadonlyArray<RoadexApprovalStatusProjection['sourceKind']> = [
  'admin-plan',
  'roadex-human-decision',
];
const ALLOWED_AUTHORITIES: ReadonlyArray<ApprovalAuthorityClass> = ['privileged-operation', 'project-workflow'];
const ALLOWED_SOURCE_SET = new Set<string>(ALLOWED_SOURCE_KINDS);
const ALLOWED_AUTHORITY_SET = new Set<string>(ALLOWED_AUTHORITIES);
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

export function createOverseerApprovalStatusProvider(options: OverseerProviderOptions): ApprovalStatusProvider {
  const apiBase = options.apiBase ?? OVERSEER_API_BASE;
  const fetchJson = options.fetchJson ?? ((path: string, token: string) => defaultFetchJson(apiBase, path, token));

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
      } catch (error) {
        throw providerError('Failed to read overseer token.', error);
      }

      const encodedRef = encodeURIComponent(canonical.approvalRef);
      const path = `${APPROVER_STATUS_PATH_PREFIX}${encodedRef}`;

      let payload: unknown;
      try {
        payload = await withTimeout(fetchJson(path, token));
      } catch (error) {
        throw providerError('Failed to read exact approval status.', error, token);
      }

      let projection: RoadexApprovalStatusProjection;
      try {
        projection = parseRoadexApprovalStatusProjection(payload);
      } catch (error) {
        throw providerError('Invalid approval status payload.', error, token);
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
        throw providerError('Approval status does not match expected scope.', undefined, token);
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

async function withTimeout<T>(value: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Overseer approval status request timed out.'));
    }, DEFAULT_TIMEOUT_MS);

    value.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function defaultFetchJson(apiBase: string, path: string, token: string): Promise<unknown> {
  const response = await fetch(`${apiBase}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`Overseer approval status request failed with HTTP ${String(response.status)}`);
  }

  const declaredLength = response.headers.get('content-length');
  const bodyLength = declaredLength === null ? undefined : Number(declaredLength);
  if (typeof bodyLength === 'number' && Number.isFinite(bodyLength) && bodyLength > MAX_RESPONSE_BYTES) {
    throw new Error('Overseer approval status response is oversized.');
  }

  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error('Overseer approval status response is oversized.');
  }

  return JSON.parse(text);
}

function parseRoadexApprovalStatusProjection(value: unknown): RoadexApprovalStatusProjection {
  if (!isRecord(value)) {
    throw new Error('Approval status is not an object.');
  }

  const keys = Object.keys(value);
  if (keys.length !== APPROVAL_PROJECTION_REQUIRED_KEY_SET.size) {
    throw new Error('Approval status has unexpected shape.');
  }
  for (const key of keys) {
    if (!APPROVAL_PROJECTION_REQUIRED_KEY_SET.has(key)) {
      throw new Error('Approval status has unexpected field.');
    }
  }
  for (const requiredKey of APPROVAL_PROJECTION_REQUIRED_KEYS) {
    if (!(requiredKey in value)) {
      throw new Error('Approval status is missing required fields.');
    }
  }

  const candidate = value as Record<string, unknown>;

  if (!ALLOWED_SOURCE_SET.has(candidate.sourceKind)) {
    throw new Error('Approval status has unsupported source kind.');
  }

  if (!ALLOWED_AUTHORITY_SET.has(candidate.authorityClass)) {
    throw new Error('Approval status has unsupported authority class.');
  }

  if (
    !isCanonicalOpaque(candidate.approvalRef, MAX_APPROVAL_REF_LENGTH)
    || !isCanonicalOpaque(candidate.projectId, MAX_SCOPE_FIELD_LENGTH)
    || !isCanonicalOpaque(candidate.workspaceId, MAX_SCOPE_FIELD_LENGTH)
    || !isCanonicalOpaque(candidate.resourceRef, MAX_SCOPE_FIELD_LENGTH)
    || !isCanonicalOpaque(candidate.authorityClass, MAX_TEXT_FIELD_LENGTH)
    || !isCanonicalOpaque(candidate.subject, MAX_TEXT_FIELD_LENGTH)
    || !isCanonicalOpaque(candidate.scopeDigest, MAX_TEXT_FIELD_LENGTH)
    || !isCanonicalOpaque(candidate.decisionVersion, MAX_TEXT_FIELD_LENGTH)
    || !isCanonicalOpaque(candidate.updatedAt, MAX_TEXT_FIELD_LENGTH)
    || typeof candidate.authorityClass !== 'string'
    || !isValidIso(candidate.updatedAt)
    || typeof candidate.decision !== 'string'
    || !APPROVAL_DECISIONS.has(candidate.decision)
  ) {
    throw new Error('Approval status has invalid values.');
  }

  return {
    approvalRef: candidate.approvalRef,
    sourceKind: candidate.sourceKind,
    projectId: candidate.projectId,
    workspaceId: candidate.workspaceId,
    resourceRef: candidate.resourceRef,
    authorityClass: candidate.authorityClass,
    subject: candidate.subject,
    scopeDigest: candidate.scopeDigest,
    decision: candidate.decision,
    decisionVersion: candidate.decisionVersion,
    updatedAt: candidate.updatedAt,
  } as RoadexApprovalStatusProjection;
}

function providerError(message: string, error?: unknown, token?: string): Error {
  const fromError = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;
  if (fromError === undefined) {
    return new Error(message);
  }
  const details = token === undefined ? fromError : redactToken(fromError, token);
  return new Error(`${message} ${details}`);
}

function redactToken(value: string, token: string): string {
  const escaped = escapeRegExp(token);
  return value
    .replace(new RegExp(`Bearer\\s+${escaped}`, 'g'), 'Bearer [redacted-token]')
    .replace(new RegExp(escaped, 'g'), '[redacted-token]');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function validateCanonicalOpaque(name: string, value: unknown, maxLength: number): string {
  if (!isCanonicalOpaqueString(value, maxLength)) {
    throw new Error(`Invalid ${name}.`);
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
  const date = Date.parse(value);
  return Number.isFinite(date) && new Date(date).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
