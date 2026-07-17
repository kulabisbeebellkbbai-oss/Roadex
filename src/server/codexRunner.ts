import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createStreamEvent } from './mockRunner.js';
import type { RoadexSession, StreamEvent, WorkspaceRef } from '../shared/sessionContracts.js';

export type RunnerPromptRequest = {
  session: RoadexSession;
  prompt: string;
};

export type RunnerPromptResult =
  | {
      ok: true;
      events: StreamEvent[];
      exitCode: number;
    }
  | {
      ok: false;
      events: StreamEvent[];
      reason: string;
      exitCode?: number;
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
      };
    },

    runPrompt({ session, prompt }) {
      return runCodexPrompt({
        executable,
        prompt,
        sessionId: session.id,
        timeoutMs,
        workspaceRoot: session.workspace.root,
      });
    },
  };
}

type RunCodexPromptOptions = {
  executable: string;
  prompt: string;
  sessionId: string;
  timeoutMs: number;
  workspaceRoot: string;
};

async function runCodexPrompt(options: RunCodexPromptOptions): Promise<RunnerPromptResult> {
  const events: StreamEvent[] = [
    createStreamEvent(options.sessionId, 'system', 'Starting Codex CLI runner.'),
  ];
  const child = spawn(
    options.executable,
    buildCodexExecArgs(options.workspaceRoot, options.prompt),
    {
      cwd: options.workspaceRoot,
      env: runnerEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, options.timeoutMs);

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    for (const message of parseCodexJsonl(chunk)) {
      events.push(createStreamEvent(options.sessionId, 'assistant', message));
    }
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  }).finally(() => clearTimeout(timeout));

  const finalMessages = parseCodexJsonl(stdout);
  if (events.length === 1 && finalMessages.length > 0) {
    for (const message of finalMessages) {
      events.push(createStreamEvent(options.sessionId, 'assistant', message));
    }
  }

  if (timedOut) {
    events.push(createStreamEvent(options.sessionId, 'system', 'Codex runner timed out and was stopped.'));
    return { ok: false, events, reason: 'runner_timeout', exitCode: exitCode ?? undefined };
  }

  if (exitCode !== 0) {
    const cleanError = sanitizeRunnerText(stderr.trim() || `Codex exited with status ${exitCode ?? 'unknown'}.`);
    events.push(createStreamEvent(options.sessionId, 'system', cleanError));
    return { ok: false, events, reason: 'runner_failed', exitCode: exitCode ?? undefined };
  }

  if (events.length === 1) {
    events.push(createStreamEvent(options.sessionId, 'assistant', 'Codex completed without streamed output.'));
  }

  events.push(createStreamEvent(options.sessionId, 'system', 'Codex runner completed.'));
  return { ok: true, events, exitCode: exitCode ?? 0 };
}

export function buildCodexExecArgs(workspaceRoot: string, prompt: string): string[] {
  return [
    'exec',
    '--json',
    '--sandbox',
    'workspace-write',
    '-C',
    workspaceRoot,
    prompt,
  ];
}

export function parseCodexJsonl(chunk: string): string[] {
  return chunk
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseCodexEvent)
    .filter((message): message is string => Boolean(message));
}

function parseCodexEvent(line: string): string | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    const message = extractMessage(parsed);
    return message ? sanitizeRunnerText(message) : undefined;
  } catch {
    return sanitizeRunnerText(line);
  }
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
