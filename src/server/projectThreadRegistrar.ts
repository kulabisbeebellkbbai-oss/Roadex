import { execFileSync, spawn } from 'node:child_process';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, unlinkSync, writeSync,
} from 'node:fs';
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

if sys.argv[1:] == ["--detach"]:
    os.execv(TMUX, [TMUX, "new-session", "-d", "-s", COMMAND, "-c", ROOT, WORKER])
if sys.argv[1:]:
    raise SystemExit("invalid project human thread launcher arguments")
os.execv(TMUX, [TMUX, "new-session", "-A", "-s", COMMAND, "-c", ROOT, WORKER])
`;
}

const CODEX_BIN = '/home/god/.local/bin/codex';
const PYTHON_BIN = '/usr/bin/python3';
const REGISTRAR = '/home/god/codex_project_manager.py';
const RENAME_NOREPLACE = `import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
if libc.renameat2(-100, os.fsencode(sys.argv[1]), -100, os.fsencode(sys.argv[2]), 1) != 0:
    raise OSError(ctypes.get_errno(), "renameat2 failed")
`;
const BOOTSTRAP_PROMPT = [
  'Initialize this already-approved Roadex project thread.',
  'Read AGENTS.md and the existing docs/a-team-summary.md and docs/a-team-plan.md.',
  'Do not replace or expand those approved documents and do not perform repository or remote operations.',
  'Confirm readiness for the next assigned implementation step.',
].join(' ');
const ROOT_LOCKED_BOOTSTRAP = `import ctypes, fcntl, hashlib, hmac, json, os, re, subprocess, sys, uuid
root, expected_dev, expected_ino, receipt_path, operation_id, executable, *args = sys.argv[1:]
receipt_key = os.environ.pop("ROADEX_BOOTSTRAP_RECEIPT_KEY", "-")
fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
st = os.fstat(fd)
if str(st.st_dev) != expected_dev or str(st.st_ino) != expected_ino:
    raise SystemExit("project root identity changed")
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit("project root already has a writer")
os.set_inheritable(fd, True)
os.chdir(root)

def thread_id(value):
    if not isinstance(value, dict):
        return None
    for key in ("thread_id", "threadId", "conversation_id", "conversationId"):
        candidate = value.get(key)
        if isinstance(candidate, str) and re.fullmatch(r"[A-Za-z0-9_-]{8,128}", candidate):
            return candidate
    return thread_id(value.get("item"))

def publish_receipt(candidate):
    if receipt_path == "-":
        return
    record = {
        "schemaVersion": "roadex.project-human-thread-bootstrap-receipt.v2",
        "operationId": operation_id,
        "projectRoot": root,
        "rootDev": expected_dev,
        "rootIno": expected_ino,
        "threadId": candidate,
    }
    payload = json.dumps(record, separators=(",", ":"), ensure_ascii=False)
    record["receiptDigest"] = hmac.new(receipt_key.encode(), payload.encode(), hashlib.sha256).hexdigest()
    content = json.dumps(record, separators=(",", ":"), ensure_ascii=False).encode()
    publish_bytes(receipt_path, content)

def publish_bytes(destination, content):
    temporary = os.path.join(os.path.dirname(destination), "." + hashlib.sha256(operation_id.encode()).hexdigest() + "." + str(uuid.uuid4()) + ".pending")
    temp_fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        offset = 0
        while offset < len(content):
            offset += os.write(temp_fd, content[offset:])
        os.fsync(temp_fd)
        os.fchmod(temp_fd, 0o600)
    finally:
        os.close(temp_fd)
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.renameat2(-100, os.fsencode(temporary), -100, os.fsencode(destination), 1) != 0:
            raise OSError(ctypes.get_errno(), "renameat2 failed")
        parent_fd = os.open(os.path.dirname(receipt_path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(parent_fd)
        finally:
            os.close(parent_fd)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass

child = subprocess.Popen(
    [executable, *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
    stderr=None, env=os.environ, pass_fds=(fd,),
)
observed_candidate = None
output = []
output_bytes = 0
assert child.stdout is not None
try:
    for line in child.stdout:
        output_bytes += len(line)
        if output_bytes > 64000:
            raise RuntimeError("bootstrap output too large")
        try:
            candidate = thread_id(json.loads(line))
        except Exception:
            candidate = None
        if candidate:
            if observed_candidate and candidate != observed_candidate:
                conflict = json.dumps({
                    "schemaVersion": "roadex.project-human-thread-bootstrap-conflict.v1",
                    "operationId": operation_id,
                    "firstThreadId": observed_candidate,
                    "conflictingThreadId": candidate,
                }, separators=(",", ":"), ensure_ascii=False).encode()
                publish_bytes(receipt_path + ".conflict", conflict)
                raise RuntimeError("bootstrap emitted conflicting thread identities")
            observed_candidate = candidate
        output.append(line)
    exit_code = child.wait()
    if observed_candidate:
        publish_receipt(observed_candidate)
    for line in output:
        sys.stdout.buffer.write(line)
        sys.stdout.buffer.flush()
except BaseException:
    child.kill()
    child.wait()
    raise
raise SystemExit(exit_code)
`;

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
      const threadId = await resolveControlledBootstrap(
        projectRoot, lease.operationId, env,
      );
      const projectIdentityDigest = projectIdentity(lease);
      await registerControlledHumanThread(
        projectRoot, threadId, env, lease.operationId, projectIdentityDigest,
      );
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

export async function bootstrapControlledThread(
  projectRoot: string,
  env: NodeJS.ProcessEnv,
  operationId?: string,
  executable = CODEX_BIN,
  timeoutMs = 120_000,
): Promise<string> {
  const rootStat = await import('node:fs').then(({ statSync }) => statSync(projectRoot));
  const receiptPath = operationId ? bootstrapReceiptPath(operationId, env) : '-';
  const receiptKey = operationId ? (env.ROADEX_CODEX_THREAD_REGISTRAR_HMAC_KEY ?? '') : '-';
  if (operationId && Buffer.byteLength(receiptKey) < 32) {
    throw new Error('project_human_thread_bootstrap_receipt_key_invalid');
  }
  const child = spawn(PYTHON_BIN, [
    '-I', '-S', '-c', ROOT_LOCKED_BOOTSTRAP,
    projectRoot, String(rootStat.dev), String(rootStat.ino), receiptPath, operationId ?? '-', executable,
    ...controlledBootstrapArgs(projectRoot),
  ], {
    cwd: projectRoot,
    env: {
      ...controlledBootstrapEnvironment(env),
      ...(operationId ? { ROADEX_BOOTSTRAP_RECEIPT_KEY: receiptKey } : {}),
    },
    shell: false,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const completion = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  let buffer = '';
  let bytes = 0;
  let threadId: string | undefined;
  let exitCode: number | null = null;
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    if (Buffer.byteLength(stderr) < 4_096) stderr += String(chunk).slice(0, 4_096 - Buffer.byteLength(stderr));
  });
  const killGroup = () => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch { child.kill('SIGKILL'); }
  };
  const timer = setTimeout(killGroup, timeoutMs);
  try {
    for await (const chunk of child.stdout) {
      bytes += (chunk as Buffer).byteLength;
      if (bytes > 64_000) throw new Error('bootstrap_output_too_large');
      const parsed = parseCodexJsonlStream(buffer + String(chunk));
      buffer = parsed.remainder;
      if (parsed.codexThreadId && parsed.codexThreadId !== threadId) {
        threadId = parsed.codexThreadId;
      }
    }
    if (buffer.trim()) {
      const parsedThreadId = parseCodexJsonlStream(`${buffer}\n`).codexThreadId;
      if (parsedThreadId && parsedThreadId !== threadId) {
        threadId = parsedThreadId;
      }
    }
    exitCode = await completion;
  } catch (error) {
    killGroup();
    await completion.catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (exitCode !== 0 || !threadId || !/^[A-Za-z0-9_-]{8,128}$/.test(threadId)) {
    const error = new Error('controlled_bootstrap_failed') as Error & { createEffect?: 'none' };
    if (stderr.includes('project root already has a writer')) error.createEffect = 'none';
    throw error;
  }
  if (operationId && readBootstrapReceipt(operationId, projectRoot, env) !== threadId) {
    throw new Error('controlled_bootstrap_receipt_conflict');
  }
  return threadId;
}

export async function resolveControlledBootstrap(
  projectRoot: string,
  operationId: string,
  env: NodeJS.ProcessEnv,
  bootstrap: typeof bootstrapControlledThread = bootstrapControlledThread,
): Promise<string> {
  const recovered = readBootstrapReceipt(operationId, projectRoot, env);
  if (recovered) return recovered;
  try {
    return await bootstrap(projectRoot, env, operationId);
  } catch (error) {
    const published = readBootstrapReceipt(operationId, projectRoot, env);
    if (published) return published;
    throw error;
  }
}

export function readBootstrapReceipt(
  operationId: string,
  projectRoot: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const receiptPath = bootstrapReceiptPath(operationId, env);
  requireNoBootstrapConflict(receiptPath);
  let lexical;
  try { lexical = lstatSync(receiptPath); } catch { return undefined; }
  if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.nlink !== 1
    || lexical.uid !== process.getuid?.() || (lexical.mode & 0o777) !== 0o600 || lexical.size > 8_192) {
    throw new Error('project_human_thread_bootstrap_receipt_invalid');
  }
  const fd = openSync(receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!sameReceiptStat(opened, lexical)) throw new Error('project_human_thread_bootstrap_receipt_changed');
    const value = JSON.parse(readFileSync(fd, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('project_human_thread_bootstrap_receipt_invalid');
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(',') !== 'operationId,projectRoot,receiptDigest,rootDev,rootIno,schemaVersion,threadId'
      || record.schemaVersion !== 'roadex.project-human-thread-bootstrap-receipt.v2'
      || record.operationId !== operationId || record.projectRoot !== projectRoot
      || typeof record.rootDev !== 'string' || !/^\d+$/.test(record.rootDev)
      || typeof record.rootIno !== 'string' || !/^\d+$/.test(record.rootIno)
      || typeof record.threadId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(record.threadId)
      || typeof record.receiptDigest !== 'string' || !/^[a-f0-9]{64}$/.test(record.receiptDigest)
      || !validBootstrapReceiptDigest(record, env)) {
      throw new Error('project_human_thread_bootstrap_receipt_invalid');
    }
    const root = secureRootIdentity(projectRoot);
    if (record.rootDev !== root.dev || record.rootIno !== root.ino) {
      throw new Error('project_human_thread_bootstrap_receipt_root_changed');
    }
    const finalOpened = fstatSync(fd);
    const finalLexical = lstatSync(receiptPath);
    if (!sameReceiptStat(opened, finalOpened) || !sameReceiptStat(opened, finalLexical)) {
      throw new Error('project_human_thread_bootstrap_receipt_changed');
    }
    return record.threadId;
  } finally { closeSync(fd); }
}

function requireNoBootstrapConflict(receiptPath: string): void {
  const conflictPath = `${receiptPath}.conflict`;
  let lexical;
  try { lexical = lstatSync(conflictPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.nlink !== 1
    || lexical.uid !== process.getuid?.() || (lexical.mode & 0o777) !== 0o600 || lexical.size > 8_192) {
    throw new Error('project_human_thread_bootstrap_conflict_invalid');
  }
  throw new Error('project_human_thread_bootstrap_conflicted');
}

function sameReceiptStat(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid
    && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export function persistBootstrapReceipt(
  operationId: string,
  projectRoot: string,
  threadId: string,
  env: NodeJS.ProcessEnv,
): void {
  const receiptPath = bootstrapReceiptPath(operationId, env);
  const root = secureRootIdentity(projectRoot);
  const receipt = {
    schemaVersion: 'roadex.project-human-thread-bootstrap-receipt.v2',
    operationId,
    projectRoot,
    rootDev: root.dev,
    rootIno: root.ino,
    threadId,
  };
  const content = JSON.stringify({
    ...receipt,
    receiptDigest: bootstrapReceiptDigest(receipt, env),
  });
  const temporary = joinPrivateReceiptTemporary(receiptPath, operationId);
  let published = false;
  try {
    const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      const bytes = Buffer.from(content);
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      fsyncSync(fd);
      fchmodSync(fd, 0o600);
    } finally { closeSync(fd); }
    execFileSync(PYTHON_BIN, ['-I', '-S', '-c', RENAME_NOREPLACE, temporary, receiptPath], {
      env: {}, stdio: ['ignore', 'ignore', 'ignore'], timeout: 5_000,
    });
    published = true;
    const parentFd = openSync(path.dirname(receiptPath), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
  } catch (error) {
    if (published || readBootstrapReceipt(operationId, projectRoot, env) !== threadId) throw error;
  } finally { try { unlinkSync(temporary); } catch { /* renamed or best-effort inert cleanup */ } }
}

function joinPrivateReceiptTemporary(receiptPath: string, operationId: string): string {
  const prefix = createHash('sha256').update(operationId).digest('hex');
  return path.join(path.dirname(receiptPath), `.${prefix}.${randomUUID()}.pending`);
}

function bootstrapReceiptDigest(
  receipt: { schemaVersion: string; operationId: string; projectRoot: string; rootDev: string; rootIno: string; threadId: string },
  env: NodeJS.ProcessEnv,
): string {
  const key = env.ROADEX_CODEX_THREAD_REGISTRAR_HMAC_KEY ?? '';
  if (Buffer.byteLength(key) < 32) throw new Error('project_human_thread_bootstrap_receipt_key_invalid');
  return createHmac('sha256', key).update(JSON.stringify(receipt)).digest('hex');
}

function validBootstrapReceiptDigest(record: Record<string, unknown>, env: NodeJS.ProcessEnv): boolean {
  const expected = bootstrapReceiptDigest({
    schemaVersion: String(record.schemaVersion),
    operationId: String(record.operationId),
    projectRoot: String(record.projectRoot),
    rootDev: String(record.rootDev),
    rootIno: String(record.rootIno),
    threadId: String(record.threadId),
  }, env);
  return timingSafeEqual(Buffer.from(expected, 'ascii'), Buffer.from(String(record.receiptDigest), 'ascii'));
}

function secureRootIdentity(projectRoot: string): { dev: string; ino: string } {
  const fd = openSync(projectRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (realpathSync(projectRoot) !== projectRoot) throw new Error('project_human_thread_bootstrap_root_invalid');
    return { dev: String(opened.dev), ino: String(opened.ino) };
  } finally { closeSync(fd); }
}

function bootstrapReceiptPath(operationId: string, env: NodeJS.ProcessEnv): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(operationId)) {
    throw new Error('project_human_thread_bootstrap_operation_invalid');
  }
  const directory = env.ROADEX_PROJECT_HUMAN_THREAD_BOOTSTRAP_RECEIPT_DIR
    ?? '/home/god/.local/share/roadex/project-human-thread/bootstrap-receipts';
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lexical = lstatSync(directory);
  if (!lexical.isDirectory() || lexical.isSymbolicLink() || lexical.uid !== process.getuid?.()
    || (lexical.mode & 0o077) !== 0 || realpathSync(directory) !== directory) {
    throw new Error('project_human_thread_bootstrap_receipt_directory_invalid');
  }
  return path.join(directory, `${createHash('sha256').update(operationId).digest('hex')}.json`);
}

export async function registerControlledHumanThread(
  projectRoot: string,
  threadId: string,
  env: NodeJS.ProcessEnv,
  operationId = `human-thread-operation-${threadId}`,
  identityDigest = createHash('sha256').update(JSON.stringify({
    projectRoot,
    purpose: 'human-interaction',
  }, ['projectRoot', 'purpose'])).digest('hex'),
): Promise<void> {
  const bootstrapBinding = createBootstrapBinding(
    operationId,
    projectRoot,
    threadId,
    identityDigest,
    env.ROADEX_CODEX_THREAD_REGISTRAR_HMAC_KEY ?? '',
  );
  const result = await invokeRegistrar({
    operation_id: operationId,
    project_root: projectRoot,
    thread_id: threadId,
    project_identity_digest: identityDigest,
    bootstrap_binding: bootstrapBinding,
  }, env);
  verifyRegistration(result, operationId, path.basename(projectRoot), threadId);
}

export function retireControlledHumanThread(
  input: { projectId: string; projectRoot: string; conversationId: string; generation: number },
  env: NodeJS.ProcessEnv,
): void {
  const operationId = `human-thread-retirement-${input.projectId}:${input.generation}`;
  const generation = String(input.generation);
  const retirementBinding = createHmac(
    'sha256', env.ROADEX_CODEX_THREAD_REGISTRAR_HMAC_KEY ?? '',
  ).update(JSON.stringify({
    generation,
    operationId,
    projectRoot: input.projectRoot,
    threadId: input.conversationId,
  })).digest('hex');
  const request = {
    operation_id: operationId,
    project_root: input.projectRoot,
    thread_id: input.conversationId,
    generation,
    retirement_binding: retirementBinding,
  };
  let value: unknown;
  try {
    value = JSON.parse(execFileSync(PYTHON_BIN, [REGISTRAR, '--retire-controlled-thread'], {
      input: JSON.stringify(request), encoding: 'utf8', timeout: 30_000,
      env: {
        ...controlledBootstrapEnvironment(env),
        ROADEX_CODEX_THREAD_REGISTRAR_ENABLED: 'true',
        ROADEX_CODEX_THREAD_REGISTRAR_HMAC_KEY: env.ROADEX_CODEX_THREAD_REGISTRAR_HMAC_KEY,
        ROADEX_CODEX_THREAD_REGISTRAR_AUDIT_HMAC_KEY: env.ROADEX_CODEX_THREAD_REGISTRAR_AUDIT_HMAC_KEY,
      },
    }));
  } catch {
    throw new Error('project_human_thread_retirement_failed');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('project_human_thread_retirement_failed');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'alreadyRetired,generation,operationId,retired,threadId'
    || record.retired !== true || typeof record.alreadyRetired !== 'boolean'
    || record.operationId !== operationId || record.threadId !== input.conversationId
    || record.generation !== input.generation) {
    throw new Error('project_human_thread_retirement_failed');
  }
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
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
