import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { createStreamEvent } from './mockRunner.js';
import { isApprovalWorkflowToken } from './approvalWorkflowGrantBroker.js';
import {
  CONTROLLED_RUNNER_CONFIG_OVERRIDES,
  CONTROLLED_OPERATION_TOKEN_DIRECTORY,
  APPROVAL_WORKFLOW_TOKEN_DIRECTORY,
  approvalWorkflowConfigOverrides,
  controlledOperationConfigOverrides,
  resolveRunnerCapabilityProfile,
  type ControlledRunnerGrant,
  type RunnerCapabilitySelection,
} from './runnerCapabilityProfile.js';
import type { RoadexSession, StreamEvent, WorkspaceRef } from '../shared/sessionContracts.js';

export type RunnerPromptRequest = {
  session: RoadexSession;
  prompt: string;
  onEvent?: (event: StreamEvent) => void;
  signal?: AbortSignal;
  capabilityGrant?: ControlledRunnerGrant;
  controlledOperationToken?: string;
  approvalWorkflowToken?: string;
  runId?: string;
  onActivity?: () => void;
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
  activityHeartbeatMs?: number;
  spawnProcess?: typeof spawn;
  approvalWorkflowTokenFileOperations?: ApprovalWorkflowTokenFileOperations;
};

export function createCodexRunner(options: CodexRunnerOptions = {}): SessionRunner {
  const executable = options.executable ?? process.env.ROADEX_CODEX_BIN ?? 'codex';
  const activityHeartbeatMs = options.activityHeartbeatMs ?? 30_000;
  const spawnProcess = options.spawnProcess ?? spawn;
  const approvalWorkflowTokenFileOperations = options.approvalWorkflowTokenFileOperations ?? {};

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

    runPrompt({ session, prompt, onEvent, onActivity, signal, capabilityGrant, controlledOperationToken, approvalWorkflowToken, runId }) {
      let capabilityProfile: RunnerCapabilitySelection;
      try {
        capabilityProfile = resolveRunnerCapabilityProfile({
          userId: session.userId,
          workspaceId: session.workspace.id,
          workspaceRoot: session.workspace.root,
          managedThreadId: session.managedThreadId,
          codexThreadId: session.codexThreadId,
        }, { grant: capabilityGrant });
      } catch {
        const event = createStreamEvent(session.id, 'system', 'Controlled runner profile validation failed.');
        onEvent?.(event);
        return Promise.resolve({
          ok: false,
          events: [event],
          reason: 'runner_profile_invalid',
        });
      }
      return runCodexPrompt({
        capabilityProfile,
        controlledOperationToken,
        approvalWorkflowToken,
        runId,
        executable,
        spawnProcess,
        approvalWorkflowTokenFileOperations,
        activityHeartbeatMs,
        onActivity,
        onEvent,
        prompt,
        signal,
        sessionId: session.id,
        codexThreadId: session.codexThreadId,
        workspaceRoot: session.workspace.root,
      });
    },
  };
}

type RunCodexPromptOptions = {
  capabilityProfile: RunnerCapabilitySelection;
  controlledOperationToken?: string;
  approvalWorkflowToken?: string;
  runId?: string;
  executable: string;
  spawnProcess: typeof spawn;
  approvalWorkflowTokenFileOperations: ApprovalWorkflowTokenFileOperations;
  activityHeartbeatMs: number;
  onActivity?: () => void;
  onEvent?: (event: StreamEvent) => void;
  prompt: string;
  signal?: AbortSignal;
  sessionId: string;
  codexThreadId?: string;
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
  let controlledOperationTokenFile: string | undefined;
  let approvalWorkflowTokenFile: string | undefined;
  let child;
  try {
    controlledOperationTokenFile = (
      options.capabilityProfile.mode === 'controlled-project-manager'
      && options.controlledOperationToken
    )
      ? createControlledOperationTokenFile(options.controlledOperationToken)
      : undefined;
    approvalWorkflowTokenFile = (
      options.capabilityProfile.mode === 'controlled-project-manager'
      && options.approvalWorkflowToken
      && options.runId
    )
      ? createApprovalWorkflowTokenFile(
          options.approvalWorkflowToken,
          options.approvalWorkflowTokenFileOperations,
        )
      : undefined;
    child = options.spawnProcess(
      options.executable,
      buildCodexExecArgs(
        options.workspaceRoot,
        options.prompt,
        options.codexThreadId,
        options.capabilityProfile,
        controlledOperationTokenFile,
        approvalWorkflowTokenFile,
        options.runId,
      ),
      {
        cwd: options.workspaceRoot,
        env: runnerEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    removeControlledOperationTokenFile(controlledOperationTokenFile);
    removeApprovalWorkflowTokenFile(
      approvalWorkflowTokenFile,
      options.approvalWorkflowTokenFileOperations,
    );
    throw error;
  }

  let stderr = '';
  let stdoutBuffer = '';
  let aborted = false;
  const activityHeartbeat = setInterval(() => {
    options.onActivity?.();
  }, options.activityHeartbeatMs);
  activityHeartbeat.unref();
  const abort = () => {
    aborted = true;
    stopChild(child);
  };
  options.signal?.addEventListener('abort', abort, { once: true });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    options.onActivity?.();
    const parsed = parseCodexJsonlStream(stdoutBuffer + chunk);
    stdoutBuffer = parsed.remainder;
    codexThreadId = parsed.codexThreadId ?? codexThreadId;
    for (const event of parsed.events) {
      if (event.message) pushEvent('assistant', event.message);
    }
  });
  child.stderr.on('data', (chunk: string) => {
    options.onActivity?.();
    stderr += chunk;
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  }).finally(() => {
    clearInterval(activityHeartbeat);
    options.signal?.removeEventListener('abort', abort);
    removeControlledOperationTokenFile(controlledOperationTokenFile);
    removeApprovalWorkflowTokenFile(
      approvalWorkflowTokenFile,
      options.approvalWorkflowTokenFileOperations,
    );
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
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 2_000).unref();
}

export function buildCodexExecArgs(
  workspaceRoot: string,
  prompt: string,
  codexThreadId?: string,
  capabilityProfile: RunnerCapabilitySelection = { mode: 'restricted' },
  controlledOperationTokenFile?: string,
  approvalWorkflowTokenFile?: string,
  runId?: string,
): string[] {
  const operationOverrides = controlledOperationConfigOverrides(controlledOperationTokenFile);
  const workflowOverrides = runId && approvalWorkflowTokenFile
    ? approvalWorkflowConfigOverrides(approvalWorkflowTokenFile)
    : [];
  const effectivePrompt = operationOverrides.length
    ? controlledOperationPrompt(prompt)
    : prompt;
  const base = [
    'exec',
    '--json',
    ...(capabilityProfile.mode === 'controlled-project-manager'
      ? [
          '--ignore-user-config',
            '--ignore-rules',
          ...[
            ...CONTROLLED_RUNNER_CONFIG_OVERRIDES,
            ...operationOverrides,
            ...workflowOverrides,
          ].flatMap((override) => ['--config', override]),
        ]
      : []),
    '--sandbox',
    'workspace-write',
    '-C',
    workspaceRoot,
  ];
  if (codexThreadId) {
    return [...base, 'resume', codexThreadId, effectivePrompt];
  }
  return [...base, effectivePrompt];
}

function controlledOperationPrompt(prompt: string): string {
  return [
    'Execute this approved directive only through the matching roadex-operations MCP tool.',
    'For dependency installation and verification, call install_and_verify_workspace with no arguments.',
    'For commit or push directives, call publish_git_changes with a concise imperative commit message.',
    'Do not run npm installation, git commit, or git push commands directly.',
    'Do not retry the operation after the tool returns; report its sanitized result.',
    `Approved directive: ${prompt}`,
  ].join('\n');
}

export function createControlledOperationTokenFile(token: string): string {
  if (!/^[A-Za-z0-9_-]{20,16000}$/.test(token)) throw new Error('controlled_operation_token_invalid');
  mkdirSync(CONTROLLED_OPERATION_TOKEN_DIRECTORY, { recursive: true, mode: 0o700 });
  const directory = lstatSync(CONTROLLED_OPERATION_TOKEN_DIRECTORY);
  if (
    !directory.isDirectory()
    || directory.isSymbolicLink()
    || directory.uid !== process.getuid?.()
    || (directory.mode & 0o077) !== 0
  ) throw new Error('controlled_operation_token_directory_invalid');
  const path = join(CONTROLLED_OPERATION_TOKEN_DIRECTORY, randomUUID());
  const descriptor = openSync(
    path,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, token, { encoding: 'utf8' });
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return path;
}

export type ApprovalWorkflowTokenFileOperations = {
  writeFile?: typeof writeFileSync;
  sync?: typeof fsyncSync;
  unlink?: typeof unlinkSync;
};

export function createApprovalWorkflowTokenFile(
  token: string,
  operations: ApprovalWorkflowTokenFileOperations = {},
): string {
  if (!isApprovalWorkflowToken(token)) throw new Error('approval_workflow_token_invalid');
  mkdirSync(APPROVAL_WORKFLOW_TOKEN_DIRECTORY, { recursive: true, mode: 0o700 });
  const directory = lstatSync(APPROVAL_WORKFLOW_TOKEN_DIRECTORY);
  if (
    !directory.isDirectory()
    || directory.isSymbolicLink()
    || directory.uid !== process.getuid?.()
    || (directory.mode & 0o077) !== 0
  ) throw new Error('approval_workflow_token_directory_invalid');
  const path = join(APPROVAL_WORKFLOW_TOKEN_DIRECTORY, randomUUID());
  const descriptor = openSync(
    path,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  let failure: unknown;
  try {
    fchmodSync(descriptor, 0o600);
    (operations.writeFile ?? writeFileSync)(descriptor, token, { encoding: 'utf8' });
    (operations.sync ?? fsyncSync)(descriptor);
  } catch (error) {
    failure = error;
  } finally {
    closeSync(descriptor);
  }
  if (failure !== undefined) {
    try {
      (operations.unlink ?? unlinkSync)(path);
    } catch {
      throw new Error('approval_workflow_token_cleanup_failed');
    }
    throw failure;
  }
  return path;
}

function removeControlledOperationTokenFile(path: string | undefined): void {
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {
    // The MCP adapter normally removes the one-time file after reading it.
  }
}

function removeApprovalWorkflowTokenFile(
  path: string | undefined,
  operations: ApprovalWorkflowTokenFileOperations = {},
): void {
  if (!path) return;
  try {
    (operations.unlink ?? unlinkSync)(path);
  } catch (error) {
    if (
      error instanceof Error
      && 'code' in error
      && (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return;
    }
    throw new Error('approval_workflow_token_cleanup_failed');
  }
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
