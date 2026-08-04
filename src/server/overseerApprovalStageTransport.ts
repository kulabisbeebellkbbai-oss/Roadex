import type { ApprovalSessionCapability } from './approvalCoordinator.js';
import {
  isTypedApprovalIntent,
  type ApprovalStageLocator,
  type ApprovalTypedIntent,
} from './approvalWorkflowMcp.js';

const OVERSEER_STAGE_URL = 'http://127.0.0.1:8766/roadex/approval-stage' as const;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 16_384;
const CONTENT_LENGTH_PATTERN = /^(?:0|[1-9]\d*)$/;
const APPROVAL_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SCOPE_FIELD_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

export type ApprovalStageTransport = (
  capability: ApprovalSessionCapability,
  intent: ApprovalTypedIntent,
  signal?: AbortSignal,
) => Promise<ApprovalStageLocator>;

export type OverseerApprovalStageTransportOptions = {
  readToken: () => string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export function createOverseerApprovalStageTransport(
  options: OverseerApprovalStageTransportOptions,
): ApprovalStageTransport {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS) {
    throw new Error('Overseer approval staging is unavailable.');
  }
  const fetchImpl = options.fetchImpl ?? fetch;

  return async (capability, intent, parentSignal) => {
    if (!isTypedApprovalIntent(intent)) {
      throw new Error('Overseer approval staging is unavailable.');
    }

    let token: string;
    try {
      token = options.readToken();
      if (!isBearerToken(token)) throw new Error('token_invalid');
    } catch {
      throw new Error('Overseer approval staging is unavailable.');
    }

    const body = JSON.stringify({ intent });
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abortFromParent = (): void => controller.abort(parentSignal?.reason);
    try {
      if (parentSignal?.aborted) {
        controller.abort(parentSignal.reason);
      } else {
        parentSignal?.addEventListener('abort', abortFromParent, { once: true });
      }
      timer = setTimeout(() => controller.abort(new DOMException('request timed out', 'TimeoutError')), timeoutMs);
      const response = await fetchImpl(OVERSEER_STAGE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
        },
        body,
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (response.status !== 200 || !response.ok) {
        throw new Error('stage_status_invalid');
      }
      const declaredLength = response.headers.get('content-length');
      if (!declaredLength || !CONTENT_LENGTH_PATTERN.test(declaredLength)) {
        throw new Error('content_length_invalid');
      }
      const length = Number(declaredLength);
      if (!Number.isSafeInteger(length) || length > MAX_RESPONSE_BYTES) {
        throw new Error('response_oversized');
      }
      if (response.headers.get('transfer-encoding')) {
        throw new Error('response_framing_invalid');
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength !== length) throw new Error('content_length_mismatch');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const parsed: unknown = JSON.parse(text);
      if (!isExactApprovalStageLocator(parsed) || !locatorMatchesCapability(parsed, capability)) {
        throw new Error('locator_invalid');
      }
      return parsed;
    } catch {
      throw new Error('Overseer approval staging is unavailable.');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortFromParent);
    }
  };
}

function locatorMatchesCapability(
  locator: ApprovalStageLocator,
  capability: ApprovalSessionCapability,
): boolean {
  return locator.projectId === capability.projectId
    && locator.workspaceId === capability.workspaceId
    && locator.resourceRef === capability.resourceRef;
}

export function isExactApprovalStageLocator(value: unknown): value is ApprovalStageLocator {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== [
    'approvalRef', 'authorityClass', 'projectId', 'provider', 'resourceRef', 'scopeDigest', 'workspaceId',
  ].join(',')) return false;
  return (
    record.provider === 'overseer'
    && typeof record.approvalRef === 'string'
    && APPROVAL_REFERENCE_PATTERN.test(record.approvalRef)
    && typeof record.projectId === 'string'
    && SCOPE_FIELD_PATTERN.test(record.projectId)
    && typeof record.workspaceId === 'string'
    && SCOPE_FIELD_PATTERN.test(record.workspaceId)
    && typeof record.resourceRef === 'string'
    && SCOPE_FIELD_PATTERN.test(record.resourceRef)
    && (record.authorityClass === 'privileged-operation' || record.authorityClass === 'project-workflow')
    && typeof record.scopeDigest === 'string'
    && SHA256_PATTERN.test(record.scopeDigest)
  );
}

function isBearerToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim()
    && !/[\r\n]/.test(value);
}
