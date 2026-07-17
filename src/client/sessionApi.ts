import type {
  ApiError,
  BootstrapResponse,
  CancelResponse,
  CloseResponse,
  MockLoginResponse,
  PromptResponse,
} from '../shared/apiContracts';
import type { CreateSessionRequest, StreamEvent } from '../shared/sessionContracts';
import { isApiError } from '../shared/apiContracts';

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
): Promise<BootstrapResponse> {
  await request('/api/sessions', {
    method: 'POST',
    token,
    body: requestBody,
  });

  return request<BootstrapResponse>('/api/bootstrap', { token });
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
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

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
