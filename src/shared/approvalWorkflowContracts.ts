export type ApprovalAuthorityClass = 'privileged-operation' | 'project-workflow';

export type ApprovalConsoleSurface = 'admin' | 'overview';

export type ApprovalDecision = 'pending' | 'approved' | 'changes-requested' | 'rejected' | 'expired' | 'revoked';

export type ApprovalProvider = 'overseer';

export const PSYCHLO_POLICY_EXCEPTION_REQUEST_SCHEMA = 'psychlo.policy-exception-request.v1' as const;
export const PSYCHLO_POLICY_EXCEPTION_OUTCOME_SCHEMA = 'psychlo.policy-exception-outcome.v1' as const;
export const PSYCHLO_USAGE_ENVELOPE_SCHEMA = 'psychlo.usage-envelope.v1.1' as const;
export const PSYCHLO_USAGE_SNAPSHOT_SCHEMA = 'psychlo.usage-snapshot.v1.1' as const;

export type PsychloPolicyExceptionStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export type PsychloPolicyExceptionRequest = {
  schemaVersion: typeof PSYCHLO_POLICY_EXCEPTION_REQUEST_SCHEMA;
  id: string;
  requestedRuleId: 'enforce-safety-reserve';
  policyRevision: number;
  actorId: string;
  requestedValue: boolean | number;
  reason: string;
  activatedAt: string;
  expiresAt: string;
  correlationId: string;
  idempotencyKey: string;
  occurredAt: string;
  scopeDigest: string;
  decisionVersion: string;
  digest: string;
};

export type PsychloPolicyExceptionOutcome = {
  schemaVersion: typeof PSYCHLO_POLICY_EXCEPTION_OUTCOME_SCHEMA;
  sourceId: 'overseer';
  status: 'approved' | 'rejected';
  exceptionId: string;
  policyRevision: number;
  ruleId: 'enforce-safety-reserve';
  requestedValue: boolean | number;
  requestDigest: string;
  decisionId: string;
  decisionDigest: string;
  actorId: string;
  correlationId: string;
  idempotencyKey: string;
  occurredAt: string;
  scopeDigest: string;
  decisionVersion: string;
  outcomeDigest: string;
  reason?: string;
  basePolicyDigest?: string;
};

export type PsychloUsageSnapshot = {
  schemaVersion: typeof PSYCHLO_USAGE_SNAPSHOT_SCHEMA;
  id: string;
  sourceId: 'overseer';
  capturedAt: string;
  policyVersion: string;
  providerResetAt: string;
  scopeDigest: string;
  decisionVersion: string;
  weeklyQuota: number;
  weeklyRemainingCapacity: number;
  dailyConsumed: number;
  otherDevelopmentConsumed: number;
  digest: string;
};

export type PsychloUsageEnvelope = {
  schemaVersion: typeof PSYCHLO_USAGE_ENVELOPE_SCHEMA;
  correlationId: string;
  idempotencyKey: string;
  occurredAt: string;
  snapshot: PsychloUsageSnapshot;
  digest: string;
};

export type PsychloPolicyExceptionFixture = {
  request: PsychloPolicyExceptionRequest;
  outcome?: PsychloPolicyExceptionOutcome;
  usageSnapshot: PsychloUsageEnvelope;
};

export type RoadexPolicyExceptionDisplay = {
  exceptionId: string;
  ruleId: 'enforce-safety-reserve';
  priorPolicyRevision: number;
  requestedValue: boolean | number;
  expiresAt: string;
  status: PsychloPolicyExceptionStatus;
  authorityClass: 'project-workflow';
  consoleSurface: 'overview';
  consolePath: '/Overseer/overview';
  requestDigest: string;
  outcomeDigest?: string;
  scopeDigest: string;
  decisionVersion: string;
};

export type ApprovalWaitState =
  | 'pending'
  | 'verification-delayed'
  | 'security-failure'
  | 'changes-requested'
  | 'rejected'
  | 'expired'
  | 'revoked'
  | 'approved-resume-queued'
  | 'resume-dispatching'
  | 'resume-reconciliation-required'
  | 'resumed'
  | 'session-closed';

export type NormalizedApprovalStatus = {
  provider: ApprovalProvider;
  approvalRef: string;
  authorityClass: ApprovalAuthorityClass;
  decision: ApprovalDecision;
  decisionVersion: string;
  projectId: string;
  workspaceId: string;
  resourceRef: string;
  subject: string;
  updatedAt: string;
};

export type RoadexApprovalStatusProjection = {
  approvalRef: string;
  sourceKind: 'admin-plan' | 'roadex-human-decision';
  projectId: string;
  workspaceId: string;
  resourceRef: string;
  authorityClass: ApprovalAuthorityClass;
  subject: string;
  scopeDigest: string;
  decision: ApprovalDecision;
  decisionVersion: string;
  updatedAt: string;
};

export type ApprovalWaitRecord = {
  id: string;
  sessionId: string;
  userId: string;
  projectId: string;
  workspaceId: string;
  managedThreadId: string;
  provider: ApprovalProvider;
  approvalRef: string;
  resourceRef: string;
  authorityClass: ApprovalAuthorityClass;
  consoleSurface: ApprovalConsoleSurface;
  subject: string;
  state: ApprovalWaitState;
  decisionVersion: string;
  continuationId: string;
  successorOfWaitId?: string;
  checkAttempt: number;
  nextCheckAt: string;
  createdAt: string;
  updatedAt: string;
  decisionObservedAt?: string;
  dispatchReservedAt?: string;
  runnerRunId?: string;
  resumedAt?: string;
};

export type WaitingApprovalSummary = {
  waitId: string;
  approvalRef: string;
  subject: string;
  consoleSurface: ApprovalConsoleSurface;
  consolePath?: string;
  state:
    | 'pending'
    | 'verification-delayed'
    | 'security-failure'
    | 'approved-resume-queued'
    | 'resume-dispatching'
    | 'resume-reconciliation-required';
  updatedAt: string;
  policyException?: RoadexPolicyExceptionDisplay;
};

export const ACTIVE_APPROVAL_WAIT_STATES = new Set<ApprovalWaitState>([
  'pending',
  'verification-delayed',
  'security-failure',
  'approved-resume-queued',
  'resume-dispatching',
  'resume-reconciliation-required',
]);

export function consoleForAuthority(value: ApprovalAuthorityClass): ApprovalConsoleSurface {
  return value === 'privileged-operation' ? 'admin' : 'overview';
}

export function isActiveApprovalWait(value: ApprovalWaitState): boolean {
  return ACTIVE_APPROVAL_WAIT_STATES.has(value);
}

const POLICY_EXCEPTION_RULE = 'enforce-safety-reserve' as const;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const ISO8601_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/;

export function parsePsychloPolicyExceptionFixture(value: unknown): PsychloPolicyExceptionFixture {
  const root = strictRecord(value, ["request", "usageSnapshot"], "fixture", ["outcome"]);
  const request = parsePolicyExceptionRequest(root.request);
  const outcome = root.outcome === undefined ? undefined : parsePolicyExceptionOutcome(root.outcome);
  const usageSnapshot = parseUsageEnvelope(root.usageSnapshot);

  if (outcome !== undefined) {
    for (const [left, right] of [
      [outcome.exceptionId, request.id],
      [outcome.policyRevision, request.policyRevision],
      [outcome.ruleId, request.requestedRuleId],
      [outcome.requestDigest, request.digest],
      [outcome.requestedValue, request.requestedValue],
      [outcome.actorId, request.actorId],
      [outcome.correlationId, request.correlationId],
      [outcome.idempotencyKey, request.idempotencyKey],
      [outcome.scopeDigest, request.scopeDigest],
      [outcome.decisionVersion, request.decisionVersion],
    ]) {
      if (left !== right) throw new Error('Policy exception outcome is not bound to the request.');
    }
  }
  if (usageSnapshot.snapshot.scopeDigest !== request.scopeDigest || usageSnapshot.snapshot.decisionVersion !== request.decisionVersion) {
    throw new Error('Policy exception usage snapshot is not bound to the request.');
  }
  return { request, ...(outcome === undefined ? {} : { outcome }), usageSnapshot };
}

export function projectPsychloPolicyException(
  fixture: PsychloPolicyExceptionFixture,
  now: Date = new Date(),
): RoadexPolicyExceptionDisplay {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Projection time is invalid.');
  const request = fixture.request;
  const expired = now.getTime() >= Date.parse(request.expiresAt);
  const status: PsychloPolicyExceptionStatus = expired ? 'expired' : fixture.outcome?.status ?? 'pending';
  return {
    exceptionId: request.id,
    ruleId: request.requestedRuleId,
    priorPolicyRevision: request.policyRevision,
    requestedValue: request.requestedValue,
    expiresAt: request.expiresAt,
    status,
    authorityClass: 'project-workflow',
    consoleSurface: 'overview',
    consolePath: '/Overseer/overview',
    requestDigest: request.digest,
    ...(fixture.outcome ? { outcomeDigest: fixture.outcome.outcomeDigest } : {}),
    scopeDigest: request.scopeDigest,
    decisionVersion: request.decisionVersion,
  };
}

export function canonicalPsychloPolicyDigest(value: Record<string, unknown>): string {
  return sha256Hex(canonicalJson(withoutDigest(value)));
}

function parsePolicyExceptionRequest(value: unknown): PsychloPolicyExceptionRequest {
  const candidate = strictRecord(value, [
    'schemaVersion', 'id', 'requestedRuleId', 'policyRevision', 'actorId', 'requestedValue', 'reason',
    'activatedAt', 'expiresAt', 'correlationId', 'idempotencyKey', 'occurredAt', 'scopeDigest', 'decisionVersion', 'digest',
  ], 'policy exception request');
  const request = {
    schemaVersion: exactLiteral(candidate.schemaVersion, PSYCHLO_POLICY_EXCEPTION_REQUEST_SCHEMA, 'schemaVersion'),
    id: safeText(candidate.id, 'id'),
    requestedRuleId: exactLiteral(candidate.requestedRuleId, POLICY_EXCEPTION_RULE, 'requestedRuleId'),
    policyRevision: nonnegativeInt(candidate.policyRevision, 'policyRevision'),
    actorId: safeText(candidate.actorId, 'actorId'),
    requestedValue: finiteValue(candidate.requestedValue, 'requestedValue'),
    reason: safeText(candidate.reason, 'reason', 512),
    activatedAt: timestamp(candidate.activatedAt, 'activatedAt'),
    expiresAt: timestamp(candidate.expiresAt, 'expiresAt'),
    correlationId: safeText(candidate.correlationId, 'correlationId'),
    idempotencyKey: safeText(candidate.idempotencyKey, 'idempotencyKey'),
    occurredAt: timestamp(candidate.occurredAt, 'occurredAt'),
    scopeDigest: digest(candidate.scopeDigest, 'scopeDigest'),
    decisionVersion: safeText(candidate.decisionVersion, 'decisionVersion'),
    digest: digest(candidate.digest, 'digest'),
  } satisfies PsychloPolicyExceptionRequest;
  if (Date.parse(request.expiresAt) <= Date.parse(request.activatedAt)) throw new Error('Policy exception expiry is invalid.');
  if (canonicalPsychloPolicyDigest(request) !== request.digest) throw new Error('Policy exception request digest mismatch.');
  return request;
}

function parsePolicyExceptionOutcome(value: unknown): PsychloPolicyExceptionOutcome {
  const candidate = strictRecord(value, [
    'schemaVersion', 'sourceId', 'status', 'exceptionId', 'policyRevision', 'ruleId', 'requestedValue', 'requestDigest',
    'decisionId', 'decisionDigest', 'actorId', 'correlationId', 'idempotencyKey', 'occurredAt', 'scopeDigest', 'decisionVersion', 'outcomeDigest',
  ], 'policy exception outcome', ['reason', 'basePolicyDigest']);
  const outcome = {
    schemaVersion: exactLiteral(candidate.schemaVersion, PSYCHLO_POLICY_EXCEPTION_OUTCOME_SCHEMA, 'schemaVersion'),
    sourceId: exactLiteral(candidate.sourceId, 'overseer', 'sourceId'),
    status: enumLiteral(candidate.status, ['approved', 'rejected'] as const, 'status'),
    exceptionId: safeText(candidate.exceptionId, 'exceptionId'),
    policyRevision: nonnegativeInt(candidate.policyRevision, 'policyRevision'),
    ruleId: exactLiteral(candidate.ruleId, POLICY_EXCEPTION_RULE, 'ruleId'),
    requestedValue: finiteValue(candidate.requestedValue, 'requestedValue'),
    requestDigest: digest(candidate.requestDigest, 'requestDigest'),
    decisionId: safeText(candidate.decisionId, 'decisionId'),
    decisionDigest: digest(candidate.decisionDigest, 'decisionDigest'),
    actorId: safeText(candidate.actorId, 'actorId'),
    correlationId: safeText(candidate.correlationId, 'correlationId'),
    idempotencyKey: safeText(candidate.idempotencyKey, 'idempotencyKey'),
    occurredAt: timestamp(candidate.occurredAt, 'occurredAt'),
    scopeDigest: digest(candidate.scopeDigest, 'scopeDigest'),
    decisionVersion: safeText(candidate.decisionVersion, 'decisionVersion'),
    outcomeDigest: digest(candidate.outcomeDigest, 'outcomeDigest'),
    ...(candidate.reason === undefined ? {} : { reason: safeText(candidate.reason, 'reason', 512) }),
    ...(candidate.basePolicyDigest === undefined ? {} : { basePolicyDigest: digest(candidate.basePolicyDigest, 'basePolicyDigest') }),
  } satisfies PsychloPolicyExceptionOutcome;
  const { outcomeDigest } = outcome;
  const digestInput: Record<string, unknown> = {
    status: outcome.status,
    exceptionId: outcome.exceptionId,
    policyRevision: outcome.policyRevision,
    ruleId: outcome.ruleId,
    requestedValue: outcome.requestedValue,
    requestDigest: outcome.requestDigest,
    decisionId: outcome.decisionId,
    decisionDigest: outcome.decisionDigest,
    scopeDigest: outcome.scopeDigest,
    decisionVersion: outcome.decisionVersion,
  };
  if (outcome.reason !== undefined) digestInput.reason = outcome.reason;
  if (outcome.basePolicyDigest !== undefined) digestInput.basePolicyDigest = outcome.basePolicyDigest;
  if (canonicalPsychloPolicyDigest(digestInput) !== outcomeDigest) throw new Error('Policy exception outcome digest mismatch.');
  return outcome;
}

function parseUsageEnvelope(value: unknown): PsychloUsageEnvelope {
  const candidate = strictRecord(value, ['schemaVersion', 'correlationId', 'idempotencyKey', 'occurredAt', 'snapshot', 'digest'], 'usage envelope');
  const snapshotCandidate = strictRecord(candidate.snapshot, [
    'schemaVersion', 'id', 'sourceId', 'capturedAt', 'policyVersion', 'providerResetAt', 'scopeDigest', 'decisionVersion',
    'weeklyQuota', 'weeklyRemainingCapacity', 'dailyConsumed', 'otherDevelopmentConsumed', 'digest',
  ], 'usage snapshot');
  const snapshot = {
    schemaVersion: exactLiteral(snapshotCandidate.schemaVersion, PSYCHLO_USAGE_SNAPSHOT_SCHEMA, 'snapshot schemaVersion'),
    id: safeText(snapshotCandidate.id, 'snapshot id'),
    sourceId: exactLiteral(snapshotCandidate.sourceId, 'overseer', 'snapshot sourceId'),
    capturedAt: timestamp(snapshotCandidate.capturedAt, 'capturedAt'),
    policyVersion: safeText(snapshotCandidate.policyVersion, 'policyVersion'),
    providerResetAt: timestamp(snapshotCandidate.providerResetAt, 'providerResetAt'),
    scopeDigest: digest(snapshotCandidate.scopeDigest, 'snapshot scopeDigest'),
    decisionVersion: safeText(snapshotCandidate.decisionVersion, 'snapshot decisionVersion'),
    weeklyQuota: nonnegativeFinite(snapshotCandidate.weeklyQuota, 'weeklyQuota'),
    weeklyRemainingCapacity: nonnegativeFinite(snapshotCandidate.weeklyRemainingCapacity, 'weeklyRemainingCapacity'),
    dailyConsumed: nonnegativeFinite(snapshotCandidate.dailyConsumed, 'dailyConsumed'),
    otherDevelopmentConsumed: nonnegativeFinite(snapshotCandidate.otherDevelopmentConsumed, 'otherDevelopmentConsumed'),
    digest: digest(snapshotCandidate.digest, 'snapshot digest'),
  } satisfies PsychloUsageSnapshot;
  if (canonicalPsychloPolicyDigest(snapshot) !== snapshot.digest) throw new Error('Usage snapshot digest mismatch.');
  const envelope = {
    schemaVersion: exactLiteral(candidate.schemaVersion, PSYCHLO_USAGE_ENVELOPE_SCHEMA, 'usage schemaVersion'),
    correlationId: safeText(candidate.correlationId, 'usage correlationId'),
    idempotencyKey: safeText(candidate.idempotencyKey, 'usage idempotencyKey'),
    occurredAt: timestamp(candidate.occurredAt, 'usage occurredAt'),
    snapshot,
    digest: digest(candidate.digest, 'usage digest'),
  } satisfies PsychloUsageEnvelope;
  if (canonicalPsychloPolicyDigest(envelope) !== envelope.digest) throw new Error('Usage envelope digest mismatch.');
  return envelope;
}

function strictRecord(value: unknown, required: string[], label: string, optional: string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([...required, ...optional]);
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.has(key)) throw new Error(`${label} has an unknown field.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new Error(`${label} has an unsafe field.`);
  }
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) throw new Error(`${label} is missing ${key}.`);
  const optionalPresent = optional.filter((key) => Object.prototype.hasOwnProperty.call(value, key));
  if (keys.length !== required.length + optionalPresent.length) throw new Error(`${label} has unexpected shape.`);
  return value as Record<string, unknown>;
}

function withoutDigest(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) if (key !== 'digest' && key !== 'outcomeDigest') result[key] = value[key];
  return result;
}

function safeText(value: unknown, field: string, max = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.trim() !== value || /<>|:\/\//.test(value)) throw new Error(`${field} is unsafe.`);
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) throw new Error(`${field} is unsafe.`);
  }
  return value;
}

function digest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) throw new Error(`${field} is not a digest.`);
  return value;
}

function timestamp(value: unknown, field: string): string {
  const text = safeText(value, field, 64);
  const match = ISO8601_PATTERN.exec(text);
  if (!match) throw new Error(`${field} is not timezone-aware ISO-8601.`);
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const hour = Number(match[4]); const minute = Number(match[5]); const second = Number(match[6]);
  const offsetHour = match[8] === 'Z' ? 0 : Number(match[10]); const offsetMinute = match[8] === 'Z' ? 0 : Number(match[11]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) throw new Error(`${field} is invalid.`);
  return text;
}

function exactLiteral<T extends string>(value: unknown, expected: T, field: string): T {
  if (value !== expected) throw new Error(`${field} is invalid.`);
  return expected;
}

function enumLiteral<T extends readonly string[]>(value: unknown, expected: T, field: string): T[number] {
  if (typeof value !== 'string' || !expected.includes(value)) throw new Error(`${field} is invalid.`);
  return value as T[number];
}

function nonnegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${field} is invalid.`);
  return value;
}

function nonnegativeFinite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${field} is invalid.`);
  return value;
}

function finiteValue(value: unknown, field: string): boolean | number {
  if (typeof value === 'boolean') return value;
  return nonnegativeOrSignedFinite(value, field);
}

function nonnegativeOrSignedFinite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} is invalid.`);
  return value;
}

function canonicalJson(value: unknown, forceFloat = false): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, forceFloat)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const floatKeys = new Set(['weeklyQuota', 'weeklyRemainingCapacity', 'dailyConsumed', 'otherDevelopmentConsumed']);
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key], floatKeys.has(key))}`).join(',')}}`;
  }
  if (forceFloat && typeof value === 'number' && Number.isInteger(value)) return `${value}.0`;
  return JSON.stringify(value);
}

function sha256Hex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const words = new Uint32Array(64);
  const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength); padded.set(bytes); padded[bytes.length] = 0x80;
  const bitLength = bytes.length * 8;
  const view = new DataView(padded.buffer); view.setUint32(paddedLength - 4, bitLength >>> 0); view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) { const s0 = rotr(words[i - 15], 7) ^ rotr(words[i - 15], 18) ^ (words[i - 15] >>> 3); const s1 = rotr(words[i - 2], 17) ^ rotr(words[i - 2], 19) ^ (words[i - 2] >>> 10); words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0; }
    let [a,b,c,d,e,f,g,h] = hash;
    for (let i = 0; i < 64; i += 1) { const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25); const ch = (e & f) ^ (~e & g); const temp1 = (h + s1 + ch + k[i] + words[i]) >>> 0; const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22); const maj = (a & b) ^ (a & c) ^ (b & c); const temp2 = (s0 + maj) >>> 0; h=g; g=f; f=e; e=(d + temp1) >>> 0; d=c; c=b; b=a; a=(temp1 + temp2) >>> 0; }
    hash[0]=(hash[0]+a)>>>0; hash[1]=(hash[1]+b)>>>0; hash[2]=(hash[2]+c)>>>0; hash[3]=(hash[3]+d)>>>0; hash[4]=(hash[4]+e)>>>0; hash[5]=(hash[5]+f)>>>0; hash[6]=(hash[6]+g)>>>0; hash[7]=(hash[7]+h)>>>0;
  }
  return [...hash].map((part) => part.toString(16).padStart(8, '0')).join('');
}

function rotr(value: number, amount: number): number { return (value >>> amount) | (value << (32 - amount)); }
