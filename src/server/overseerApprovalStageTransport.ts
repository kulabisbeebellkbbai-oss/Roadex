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
    let responseHeadersReceived = false;
    let responseSucceeded = false;
    let responseBody: ReadableStream<Uint8Array> | null = null;
    let responseReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let bodyCancellation: Promise<void> | undefined;
    const cancelResponseBody = (): Promise<void> => {
      if (bodyCancellation !== undefined) return bodyCancellation;
      try {
        const cancellation = responseReader !== undefined
          ? responseReader.cancel()
          : responseBody !== null && !responseBody.locked
            ? responseBody.cancel()
            : Promise.resolve();
        bodyCancellation = Promise.resolve(cancellation).then(() => undefined, () => undefined);
      } catch {
        bodyCancellation = Promise.resolve();
      }
      return bodyCancellation;
    };
    const abortTransport = (reason?: unknown): void => {
      try {
        if (!controller.signal.aborted) controller.abort(reason);
      } catch {
        // The transport remains fail-closed even if abort bookkeeping fails.
      }
      void cancelResponseBody();
    };
    const abortFromParent = (): void => abortTransport(parentSignal?.reason);
    const cancelBodyOnAbort = (): void => {
      void cancelResponseBody();
    };
    try {
      controller.signal.addEventListener('abort', cancelBodyOnAbort, { once: true });
      if (parentSignal?.aborted) {
        abortTransport(parentSignal.reason);
      } else {
        parentSignal?.addEventListener('abort', abortFromParent, { once: true });
      }
      timer = setTimeout(() => abortTransport(new DOMException('request timed out', 'TimeoutError')), timeoutMs);
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
      responseHeadersReceived = true;
      responseBody = response.body;
      if (controller.signal.aborted) throw new Error('stage_aborted');
      if (response.status !== 200 || !response.ok) {
        throw new Error('stage_status_invalid');
      }
      if (response.headers.has('content-encoding')) {
        throw new Error('response_encoding_invalid');
      }
      if (response.headers.has('transfer-encoding')) {
        throw new Error('response_framing_invalid');
      }
      const declaredLength = response.headers.get('content-length');
      if (!declaredLength || !CONTENT_LENGTH_PATTERN.test(declaredLength)) {
        throw new Error('content_length_invalid');
      }
      const length = Number(declaredLength);
      if (!Number.isSafeInteger(length) || length > MAX_RESPONSE_BYTES) {
        throw new Error('response_oversized');
      }
      if (responseBody === null) throw new Error('response_body_missing');
      responseReader = responseBody.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let text = '';
      let totalBytes = 0;
      while (true) {
        const result = await responseReader.read();
        if (controller.signal.aborted) throw new Error('stage_aborted');
        if (result.done) break;
        if (result.value === undefined || result.value.byteLength === 0) continue;
        totalBytes += result.value.byteLength;
        if (totalBytes > length || totalBytes > MAX_RESPONSE_BYTES) {
          throw new Error('response_oversized');
        }
        text += decoder.decode(result.value, { stream: true });
      }
      text += decoder.decode();
      if (totalBytes !== length) throw new Error('content_length_mismatch');
      const parsed: unknown = JSON.parse(text);
      if (!isExactApprovalStageLocator(parsed) || !locatorMatchesCapability(parsed, capability)) {
        throw new Error('locator_invalid');
      }
      responseSucceeded = true;
      return parsed;
    } catch {
      if (responseHeadersReceived && !responseSucceeded) {
        abortTransport();
        void cancelResponseBody();
      }
      throw new Error('Overseer approval staging is unavailable.');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortFromParent);
      controller.signal.removeEventListener('abort', cancelBodyOnAbort);
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
