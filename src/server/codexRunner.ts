import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createStreamEvent } from './mockRunner.js';
import type { RoadexSession, StreamEvent, WorkspaceRef } from '../shared/sessionContracts.js';

export type RunnerPromptRequest = {
  session: RoadexSession;
  prompt: string;
  onEvent?: (event: StreamEvent) => void;
  signal?: AbortSignal;
};

export type RunnerPromptResult =
  | {
      ok: true;
      events: StreamEvent[];
      exitCode: number;
      codexThreadId?: string;
    }
  | {
      ok: false;
      events: StreamEvent[];
      reason: string;
      exitCode?: number;
      codexThreadId?: string;
    };

export type SessionRunner = {
  createSession: (request: {
    userId: string;
    workspace: WorkspaceRef;
    requestedDeviceBridge?: boolean;
  }) => RoadexSession;
  runPrompt: (request: RunnerPromptRequest) => Promise<RunnerPromptResult>;
};

export type CodexRunnerOptions = {
  executable?: string;
  timeoutMs?: number;
};

export function createCodexRunner(options: CodexRunnerOptions = {}): SessionRunner {
  const executable = options.executable ?? process.env.ROADEX_CODEX_BIN ?? 'codex';
  const timeoutMs = options.timeoutMs ?? Number(process.env.ROADEX_CODEX_TIMEOUT_MS ?? 600_000);

  return {
    createSession({ userId, workspace }) {
      const now = new Date().toISOString();
      return {
        id: `codex-${workspace.id}-${randomUUID()}`,
        userId,
        workspace,
        lifecycle: 'ready',
        runnerMode: 'codex',
        transport: 'sse',
        deviceBridge: 'disabled',
        gates: [
          {
            id: 'auth',
            label: 'Authenticated user',
            state: 'passed',
            description: 'A verified user identity is required before creating a session.',
          },
          {
            id: 'workspace',
            label: 'Workspace scope',
            state: 'passed',
            description: 'The workspace is server-approved and bound to the user.',
          },
          {
            id: 'audit',
            label: 'Audit trail',
            state: 'passed',
            description: 'Session lifecycle and sensitive decisions are logged.',
          },
          {
            id: 'device-bridge',
            label: 'Client device bridge',
            state: 'deferred',
            description: 'USB and local peripherals stay disabled until security review.',
          },
        ],
        createdAt: now,
        updatedAt: now,
      };
    },

    runPrompt({ session, prompt, onEvent, signal }) {
      return runCodexPrompt({
        executable,
        onEvent,
        prompt,
        signal,
        sessionId: session.id,
        codexThreadId: session.codexThreadId,
        timeoutMs,
        workspaceRoot: session.workspace.root,
      });
    },
  };
}

type RunCodexPromptOptions = {
  executable: string;
  onEvent?: (event: StreamEvent) => void;
  prompt: string;
  signal?: AbortSignal;
  sessionId: string;
  codexThreadId?: string;
  timeoutMs: number;
  workspaceRoot: string;
};

async function runCodexPrompt(options: RunCodexPromptOptions): Promise<RunnerPromptResult> {
  const events: StreamEvent[] = [];
  let codexThreadId: string | undefined = options.codexThreadId;
  const pushEvent = (kind: StreamEvent['kind'], message: string): void => {
    const event = createStreamEvent(options.sessionId, kind, message);
    events.push(event);
    options.onEvent?.(event);
  };
  pushEvent('system', 'Starting Codex CLI runner.');
  const child = spawn(
    options.executable,
    buildCodexExecArgs(options.workspaceRoot, options.prompt, options.codexThreadId),
    {
      cwd: options.workspaceRoot,
      env: runnerEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stderr = '';
  let stdoutBuffer = '';
  let timedOut = false;
  let aborted = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    stopChild(child);
  }, options.timeoutMs);
  const abort = () => {
    aborted = true;
    stopChild(child);
  };
  options.signal?.addEventListener('abort', abort, { once: true });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    const parsed = parseCodexJsonlStream(stdoutBuffer + chunk);
    stdoutBuffer = parsed.remainder;
    codexThreadId = parsed.codexThreadId ?? codexThreadId;
    for (const event of parsed.events) {
      if (event.message) pushEvent('assistant', event.message);
    }
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  }).finally(() => {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  });

  if (stdoutBuffer.trim()) {
    const parsed = parseCodexJsonlEvents(stdoutBuffer);
    codexThreadId = parsed.codexThreadId ?? codexThreadId;
    for (const event of parsed.events) {
      if (event.message) pushEvent('assistant', event.message);
    }
  }

  if (aborted) {
    pushEvent('system', 'Codex runner was cancelled.');
    return { ok: false, events, reason: 'runner_cancelled', exitCode: exitCode ?? undefined, codexThreadId };
  }

  if (timedOut) {
    pushEvent('system', 'Codex runner timed out and was stopped.');
    return { ok: false, events, reason: 'runner_timeout', exitCode: exitCode ?? undefined, codexThreadId };
  }

  if (exitCode !== 0) {
    const cleanError = sanitizeRunnerText(stderr.trim() || `Codex exited with status ${exitCode ?? 'unknown'}.`);
    pushEvent('system', cleanError);
    return { ok: false, events, reason: 'runner_failed', exitCode: exitCode ?? undefined, codexThreadId };
  }

  if (events.length === 1) {
    pushEvent('assistant', 'Codex completed without streamed output.');
  }

  pushEvent('system', 'Codex runner completed.');
  return { ok: true, events, exitCode: exitCode ?? 0, codexThreadId };
}

function stopChild(child: ChildProcess): void {
  if (child.killed) return;
  child.kill('SIGTERM');
  setTimeout(() => {
    if (!child.killed) child.kill('SIGKILL');
  }, 2_000).unref();
}

export function buildCodexExecArgs(workspaceRoot: string, prompt: string, codexThreadId?: string): string[] {
  const base = [
    'exec',
    '--json',
    '--sandbox',
    'workspace-write',
    '-C',
    workspaceRoot,
  ];
  if (codexThreadId) {
    return [...base, 'resume', codexThreadId, prompt];
  }
  return [...base, prompt];
}

export function parseCodexJsonl(chunk: string): string[] {
  return parseCodexJsonlEvents(chunk).events
    .map((event) => event.message)
    .filter((message): message is string => Boolean(message));
}

export type ParsedCodexEvent = {
  message?: string;
  codexThreadId?: string;
};

export function parseCodexJsonlEvents(chunk: string): { events: ParsedCodexEvent[]; codexThreadId?: string } {
  const events = chunk
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseCodexEvent)
    .filter((event): event is ParsedCodexEvent => Boolean(event && (event.message || event.codexThreadId)));
  return {
    events,
    codexThreadId: [...events].reverse().find((event) => event.codexThreadId)?.codexThreadId,
  };
}

export function parseCodexJsonlStream(chunk: string): { events: ParsedCodexEvent[]; remainder: string; codexThreadId?: string } {
  const lines = chunk.split(/\r?\n/);
  const remainder = lines.pop() ?? '';
  const parsed = parseCodexJsonlEvents(lines.join('\n'));
  return {
    ...parsed,
    remainder,
  };
}

function parseCodexEvent(line: string): ParsedCodexEvent | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    const codexThreadId = extractThreadId(parsed);
    const message = extractMessage(parsed);
    return message || codexThreadId
      ? {
          message: message ? sanitizeRunnerText(message) : undefined,
          codexThreadId,
        }
      : undefined;
  } catch {
    return { message: sanitizeRunnerText(line) };
  }
}

function extractThreadId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['thread_id', 'threadId', 'conversation_id', 'conversationId']) {
    if (typeof record[key] === 'string') return record[key];
  }
  if (record.item) return extractThreadId(record.item);
  return undefined;
}

function extractMessage(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.item) {
    return extractMessage(record.item);
  }
  for (const key of ['message', 'text', 'content', 'summary']) {
    if (typeof record[key] === 'string') return record[key];
  }
  if (Array.isArray(record.items)) {
    return record.items
      .map(extractMessage)
      .filter(Boolean)
      .join('\n');
  }
  if (record.type === 'final_answer' && typeof record.final_answer === 'string') {
    return record.final_answer;
  }
  return undefined;
}

function sanitizeRunnerText(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted-token]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted-token]')
    .slice(0, 12_000);
}

function runnerEnvironment(): NodeJS.ProcessEnv {
  const allowed = ['CODEX_HOME', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'SHELL', 'TERM', 'USER'];
  return Object.fromEntries(
    allowed
      .map((key) => [key, process.env[key]])
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}
