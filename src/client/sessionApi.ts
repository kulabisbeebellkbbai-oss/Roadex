import type {
  ApiError,
  BootstrapResponse,
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
