import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import path from 'node:path';
import { buildCodexExecArgs, parseCodexJsonlStream } from './codexRunner.js';
import { CONTROLLED_RUNNER_PROFILE } from './runnerCapabilityProfile.js';
import { loadManagedCodexThreads } from './codexProjectsRegistry.js';
import type { ProjectCreationExecutionLease } from './projectCreationBroker.js';

/**
 * The registry and launcher are derived locators, but the project-human
 * thread adapter must derive them from one immutable contract.  Keeping these
 * values here (rather than duplicating them in the authority) prevents a
 * newly-created thread from being unadoptable immediately after bootstrap.
 */
export const PROJECT_HUMAN_THREAD_SOURCE = 'registry+codex-state' as const;

export type ProjectHumanThreadLocatorInput = {
  projectName: string;
  projectRoot: string;
  conversationId: string;
  dev: string;
  ino: string;
  launcherDirectory?: string;
  tmuxExecutable?: string;
  sessionExecutable?: string;
};

export type ProjectHumanThreadLocator = {
  label: string;
  source: typeof PROJECT_HUMAN_THREAD_SOURCE;
  command: string;
  launcher: string;
  content: string;
};

export function projectHumanThreadLabel(projectName: string): string {
  if (!/^[^\r\n\t]{1,120}$/.test(projectName) || projectName.trim() !== projectName) {
    throw new Error('project_human_thread_project_name_invalid');
  }
  return `This is the dedicated Roadex human interaction thread for the ${projectName} project. Do not use another thread for human interaction.`;
}

export function projectHumanThreadLocator(input: ProjectHumanThreadLocatorInput): ProjectHumanThreadLocator {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.conversationId)) {
    throw new Error('project_human_thread_conversation_identity_invalid');
  }
  if (!/^\d+$/.test(input.dev) || !/^\d+$/.test(input.ino)) {
    throw new Error('project_human_thread_root_identity_invalid');
  }
  const command = `codex-${slugify(input.projectName)}-${input.conversationId.slice(0, 8)}`;
  const launcherDirectory = input.launcherDirectory ?? '/home/god/.local/bin';
  const launcher = `${launcherDirectory}/${command}`;
  return {
    label: projectHumanThreadLabel(input.projectName),
    source: PROJECT_HUMAN_THREAD_SOURCE,
    command,
    launcher,
    content: projectHumanThreadLauncherContent({
      ...input,
      command,
      launcher,
      tmuxExecutable: input.tmuxExecutable ?? '/usr/bin/tmux',
      sessionExecutable: input.sessionExecutable ?? '/home/god/.local/bin/codex-memory-session',
    }),
  };
}

export function projectHumanThreadLauncherContent(input: {
  command: string;
  launcher: string;
  projectRoot: string;
  dev: string;
  ino: string;
  conversationId: string;
  tmuxExecutable: string;
  sessionExecutable: string;
}): string {
  const worker = [input.launcher, '--worker'].map(shellQuote).join(' ');
  return `#!/usr/bin/python3
import fcntl
import os
import sys

ROOT = ${JSON.stringify(input.projectRoot)}
EXPECTED_DEV = ${JSON.stringify(input.dev)}
EXPECTED_INO = ${JSON.stringify(input.ino)}
TMUX = ${JSON.stringify(input.tmuxExecutable)}
SESSION = ${JSON.stringify(input.sessionExecutable)}
COMMAND = ${JSON.stringify(input.command)}
CONVERSATION = ${JSON.stringify(input.conversationId)}
WORKER = ${JSON.stringify(worker)}

if sys.argv[1:] == ["--worker"]:
    fd = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    stat = os.fstat(fd)
    if str(stat.st_dev) != EXPECTED_DEV or str(stat.st_ino) != EXPECTED_INO:
        raise SystemExit("project human thread root identity changed")
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("project human thread already has a writer")
    os.set_inheritable(fd, True)
    os.chdir(ROOT)
    os.execv(SESSION, [SESSION, "resume", CONVERSATION, "--cd", ROOT])

if sys.argv[1:]:
    raise SystemExit("invalid project human thread launcher arguments")
os.execv(TMUX, [TMUX, "new-session", "-A", "-s", COMMAND, "-c", ROOT, WORKER])
`;
}

const CODEX_BIN = '/home/god/.local/bin/codex';
const PYTHON_BIN = '/usr/bin/python3';
const REGISTRAR = '/home/god/codex_project_manager.py';
const BOOTSTRAP_PROMPT = [
  'Initialize this already-approved Roadex project thread.',
  'Read AGENTS.md and the existing docs/a-team-summary.md and docs/a-team-plan.md.',
  'Do not replace or expand those approved documents and do not perform repository or remote operations.',
  'Confirm readiness for the next assigned implementation step.',
].join(' ');

type RegistrationDto = {
  registered: true;
  alreadyRegistered: boolean;
  operationId: string;
  projectName: string;
  threadId: string;
};

export type ProjectThreadFinalizer = {
  ready: () => boolean;
  finalize: (lease: ProjectCreationExecutionLease) => Promise<ProjectThreadFinalization>;
};

export type ProjectThreadFinalization = {
  workspaceId: string;
  workspaceRoot: string;
  managedThreadId: string;
};

export function createProjectThreadFinalizer(
  env: NodeJS.ProcessEnv = process.env,
): ProjectThreadFinalizer {
  return {
    ready() {
      return (
        env.ROADEX_PROJECT_CREATION_BOOTSTRAP_ENABLED === 'true'
        && env.ROADEX_CODEX_THREAD_REGISTRAR_ENABLED === 'true'
        && Buffer.byteLength(env.ROADEX_CODEX_THREAD_REGISTRAR_HMAC_KEY ?? '') >= 32
        && Buffer.byteLength(env.ROADEX_CODEX_THREAD_REGISTRAR_AUDIT_HMAC_KEY ?? '') >= 32
        && env.ROADEX_CODEX_THREAD_REGISTRAR_HMAC_KEY
          !== env.ROADEX_CODEX_THREAD_REGISTRAR_AUDIT_HMAC_KEY
      );
    },
    async finalize(lease) {
      if (!this.ready()) throw new Error('thread_finalizer_disabled');
      const projectRoot = path.join(lease.spec.workspaceRoot, lease.spec.projectName);
      const threadId = await bootstrapControlledThread(projectRoot, env);
      const projectIdentityDigest = projectIdentity(lease);
      const bootstrapBinding = createBootstrapBinding(
        lease.operationId,
        projectRoot,
        threadId,
        projectIdentityDigest,
        env.ROADEX_CODEX_THREAD_REGISTRAR_HMAC_KEY!,
      );
      const result = await invokeRegistrar({
        operation_id: lease.operationId,
        project_root: projectRoot,
        thread_id: threadId,
        project_identity_digest: projectIdentityDigest,
        bootstrap_binding: bootstrapBinding,
      }, env);
      verifyRegistration(result, lease.operationId, lease.spec.projectName, threadId);
      const registered = loadManagedCodexThreads().find(
        (candidate) => candidate.id === threadId && candidate.project.root === projectRoot,
      );
      if (!registered) throw new Error('registered_thread_not_resolvable');
      return {
        workspaceId: registered.project.id,
        workspaceRoot: registered.project.root,
        managedThreadId: registered.id,
      };
    },
  };
}

export function controlledBootstrapArgs(projectRoot: string): string[] {
  return buildCodexExecArgs(
    projectRoot,
    BOOTSTRAP_PROMPT,
    undefined,
    { mode: 'controlled-project-manager', profile: CONTROLLED_RUNNER_PROFILE },
  );
}

export function controlledBootstrapEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = ['CODEX_HOME', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'SHELL', 'TERM', 'USER'];
  return Object.fromEntries(
    allowed.flatMap((name) => typeof env[name] === 'string' ? [[name, env[name]]] : []),
  );
}

export async function bootstrapControlledThread(projectRoot: string, env: NodeJS.ProcessEnv): Promise<string> {
  const child = spawn(CODEX_BIN, controlledBootstrapArgs(projectRoot), {
    cwd: projectRoot,
    env: controlledBootstrapEnvironment(env),
    shell: false,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const completion = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  let buffer = '';
  let bytes = 0;
  let threadId: string | undefined;
  let exitCode: number | null = null;
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
  try {
    for await (const chunk of child.stdout) {
      bytes += (chunk as Buffer).byteLength;
      if (bytes > 64_000) throw new Error('bootstrap_output_too_large');
      const parsed = parseCodexJsonlStream(buffer + String(chunk));
      buffer = parsed.remainder;
      threadId = parsed.codexThreadId ?? threadId;
    }
    if (buffer.trim()) {
      threadId = parseCodexJsonlStream(`${buffer}\n`).codexThreadId ?? threadId;
    }
    exitCode = await completion;
  } catch (error) {
    child.kill('SIGKILL');
    await completion.catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (exitCode !== 0 || !threadId || !/^[A-Za-z0-9_-]{8,128}$/.test(threadId)) {
    throw new Error('controlled_bootstrap_failed');
  }
  return threadId;
}

async function invokeRegistrar(
  request: Record<string, string>,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  const child = spawn(PYTHON_BIN, [REGISTRAR, '--register-controlled-thread'], {
    shell: false,
    stdio: ['pipe', 'pipe', 'ignore'],
    env: {
      ...controlledBootstrapEnvironment(env),
      ROADEX_CODEX_THREAD_REGISTRAR_ENABLED: 'true',
      ROADEX_CODEX_THREAD_REGISTRAR_HMAC_KEY: env.ROADEX_CODEX_THREAD_REGISTRAR_HMAC_KEY,
      ROADEX_CODEX_THREAD_REGISTRAR_AUDIT_HMAC_KEY:
        env.ROADEX_CODEX_THREAD_REGISTRAR_AUDIT_HMAC_KEY,
    },
  });
  const completion = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  child.stdin.end(JSON.stringify(request));
  let output = '';
  let timedOut = false;
  let exitCode: number | null = null;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 30_000);
  try {
    for await (const chunk of child.stdout) {
      if (Buffer.byteLength(output) + (chunk as Buffer).byteLength > 16_384) {
        throw new Error('registrar_output_too_large');
      }
      output += String(chunk);
    }
    exitCode = await completion;
  } catch (error) {
    child.kill('SIGKILL');
    await completion.catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (timedOut || exitCode !== 0) throw new Error('registrar_failed');
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('registrar_response_invalid');
  }
}

function projectIdentity(lease: ProjectCreationExecutionLease): string {
  return createHash('sha256').update(JSON.stringify({
    githubOwner: lease.spec.githubOwner,
    operationId: lease.operationId,
    projectName: lease.spec.projectName,
    visibility: lease.spec.visibility,
  }, Object.keys({
    githubOwner: true,
    operationId: true,
    projectName: true,
    visibility: true,
  }).sort())).digest('hex');
}

function createBootstrapBinding(
  operationId: string,
  projectRoot: string,
  threadId: string,
  projectIdentityDigest: string,
  key: string,
): string {
  return createHmac('sha256', key).update(JSON.stringify({
    operationId,
    projectIdentityDigest,
    projectRoot,
    threadId,
  }, Object.keys({
    operationId: true,
    projectIdentityDigest: true,
    projectRoot: true,
    threadId: true,
  }).sort())).digest('hex');
}

function verifyRegistration(
  value: unknown,
  operationId: string,
  projectName: string,
  threadId: string,
): asserts value is RegistrationDto {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('registrar_response_invalid');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !== 'alreadyRegistered,operationId,projectName,registered,threadId'
    || record.registered !== true
    || typeof record.alreadyRegistered !== 'boolean'
    || record.operationId !== operationId
    || record.projectName !== projectName
    || record.threadId !== threadId
  ) throw new Error('registrar_response_invalid');
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'codex';
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `\'"'"'`)}'`;
}
