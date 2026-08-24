import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { buildCodexExecArgs, parseCodexJsonlEvents, parseCodexJsonlStream } from './codexRunner.js';
import type { ProjectHumanThreadBinding } from '../shared/projectHumanThreadContracts.js';
import type { ProjectHumanThreadTurn } from '../shared/projectHumanThreadConversationContracts.js';
import { CONTROLLED_WRITER_HANDOFF_ERROR, LIVE_WRITER_HANDOFF_ERROR, type ProjectHumanThreadConversationStore } from './projectHumanThreadConversationStore.js';

type Authority = {
  current(projectId: string): ProjectHumanThreadBinding | undefined;
  hasLiveLocator(binding: ProjectHumanThreadBinding): boolean;
  handoffToRoadex?(binding: ProjectHumanThreadBinding): void;
};
type Options = { executable?: string; pythonExecutable?: string; spawnProcess?: typeof spawn; timeoutMs?: number };

const WRITER_HELPER = `import fcntl,os,sys
if os.read(0,1) != b"1": raise SystemExit(70)
try: fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError: raise SystemExit(73)
os.set_inheritable(3, True)
os.execv(sys.argv[1], sys.argv[1:])`;

export class ProjectHumanThreadConversationDispatcher {
  readonly #store: ProjectHumanThreadConversationStore;
  readonly #authority: Authority;
  readonly #executable: string;
  readonly #spawn: typeof spawn;
  readonly #pythonExecutable: string;
  readonly #timeoutMs: number;
  readonly #children = new Map<string, { child: ReturnType<typeof spawn>; closed: Promise<void> }>();
  readonly #dispatches = new Set<Promise<void>>();
  #shuttingDown = false;

  constructor(store: ProjectHumanThreadConversationStore, authority: Authority, options: Options = {}) {
    this.#store = store; this.#authority = authority;
    this.#executable = options.executable ?? process.env.ROADEX_CODEX_BIN ?? 'codex';
    this.#spawn = options.spawnProcess ?? spawn;
    this.#pythonExecutable = options.pythonExecutable ?? '/usr/bin/python3';
    this.#timeoutMs = options.timeoutMs ?? 120_000;
  }

  async dispatch(turnId: string): Promise<ProjectHumanThreadTurn> {
    if (this.#shuttingDown) throw new Error('Project human thread dispatcher is shutting down.');
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    this.#dispatches.add(settled);
    try {
      return await this.#dispatchOne(turnId);
    } finally {
      settle();
      this.#dispatches.delete(settled);
    }
  }

  async #dispatchOne(turnId: string): Promise<ProjectHumanThreadTurn> {
    let queued = this.#store.get(turnId);
    if (!queued) throw new Error('Project human thread turn is missing.');
    const binding = this.#authority.current(queued.projectId);
    if (!binding || binding.status !== 'active' || binding.generation !== queued.generation || binding.conversationId !== queued.conversationId) {
      const failed = this.#store.fail(turnId, 'The project human-thread binding changed before dispatch.', true);
      throw new Error(`Project human thread turn is reconciliation-required: ${failed.error}`);
    }
    try {
      if (queued.writerHandoff === 'required' || this.#authority.hasLiveLocator(binding)) {
        if (!this.#authority.handoffToRoadex) {
          const failed = this.#store.fail(turnId, LIVE_WRITER_HANDOFF_ERROR, true);
          throw new Error(`Project human thread turn is reconciliation-required: ${failed.error}`);
        }
        if (queued.writerHandoff !== 'required') queued = this.#store.requireHandoff(turnId);
        try {
          this.#authority.handoffToRoadex(binding);
          if (this.#authority.hasLiveLocator(binding)) throw new Error('Project human thread locator remains live after handoff.');
          queued = this.#store.completeHandoff(turnId);
        } catch {
          const failed = this.#store.fail(turnId, CONTROLLED_WRITER_HANDOFF_ERROR, true);
          throw new Error(`Project human thread turn is reconciliation-required: ${failed.error}`);
        }
      }
      const running = this.#store.claim(turnId);
      try {
        const result = await this.#run(running, binding);
        if (result.returnedConversationId !== running.conversationId) {
          const failed = this.#store.fail(turnId, 'Codex returned a different conversation identity than the active binding.', true);
          throw new Error(`Project human thread turn is reconciliation-required: ${failed.error}`);
        }
        return this.#store.complete(turnId, result.returnedConversationId, result.assistantOutput);
      } catch (error) {
        if (/reconciliation-required/.test(error instanceof Error ? error.message : '')) throw error;
        const failed = this.#store.fail(turnId, persistedFailure(error), true);
        throw new Error(`Project human thread turn is reconciliation-required: ${failed.error}`);
      }
    } finally { /* the child-held project-root flock is released only on child exit */ }
  }

  async dispatchPending(): Promise<{ completed: number; failed: number }> {
    let completed = 0; let failed = 0;
    if (this.#shuttingDown) return { completed, failed };
    this.#store.requeueHandoffRequired();
    for (const turn of this.#store.pendingOutbox()) {
      try { await this.dispatch(turn.turnId); completed += 1; } catch { failed += 1; }
    }
    return { completed, failed };
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    const owned = [...this.#children.values()];
    for (const { child } of owned) {
      try { child.kill('SIGTERM'); } catch { /* process may already be gone */ }
    }
    const force = setTimeout(() => {
      for (const { child } of this.#children.values()) {
        try { child.kill('SIGKILL'); } catch { /* process may already be gone */ }
      }
    }, 2_000);
    force.unref();
    await Promise.all(owned.map(({ closed }) => closed));
    await Promise.all([...this.#dispatches]);
    clearTimeout(force);
  }

  async #run(turn: ProjectHumanThreadTurn, binding: ProjectHumanThreadBinding): Promise<{ returnedConversationId: string; assistantOutput: string }> {
    const projectRoot = binding.root.canonicalPath;
    const args = buildCodexExecArgs(projectRoot, turn.content, turn.conversationId);
    const rootFd = openBoundProjectRoot(binding);
    let child: ReturnType<typeof spawn>;
    try {
      child = this.#spawn(this.#pythonExecutable, ['-I', '-S', '-c', WRITER_HELPER, this.#executable, ...args], {
        cwd: projectRoot,
        env: safeCodexEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe', rootFd],
      });
    } finally {
      closeSync(rootFd);
    }
    if (!child.pid) {
      try { child.kill('SIGKILL'); } catch { /* best effort */ }
      throw new Error('Codex conversation worker identity is unavailable.');
    }
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    this.#children.set(turn.turnId, { child, closed });
    child.once('close', () => { this.#children.delete(turn.turnId); });
    try {
      this.#store.bindWorker(turn.turnId, child.pid, readProcessStartTicks(child.pid));
      child.stdin?.write('1');
      child.stdin?.end();
    } catch (error) {
      try { child.kill('SIGKILL'); } catch { /* best effort */ }
      await closed;
      throw error;
    }
    return new Promise((resolve, reject) => {
      let buffer = ''; let stderr = ''; let bytes = 0; let returned: string | undefined; let terminal = ''; let finished = false; let terminalError: Error | undefined;
      const finishReject = (error: Error): void => { if (finished) return; finished = true; reject(error); };
      let timeoutError: Error | undefined;
      const timer = setTimeout(() => {
        timeoutError = new Error('Codex conversation dispatch timed out.');
        try { child.kill('SIGTERM'); } catch { /* process may already be gone */ }
        // Keep the dispatcher promise and writer lease alive until the child
        // actually closes. Releasing either while a timed-out writer may still
        // run would permit a replacement generation to overlap it.
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* best effort */ } }, 2_000).unref();
      }, this.#timeoutMs);
      timer.unref();
      const consume = (chunk: string): void => {
        bytes += Buffer.byteLength(chunk, 'utf8');
        if (bytes > 64_000) {
          terminalError = new Error('Codex conversation output is too large.');
          clearTimeout(timer);
          try { child.kill('SIGKILL'); } catch { /* best effort */ }
          return;
        }
        const parsed = parseCodexJsonlStream(buffer + chunk); buffer = parsed.remainder;
        if (parsed.codexThreadId) returned = parsed.codexThreadId;
        terminal = terminalMessage(parsed.events.map((event) => event.message).filter((message): message is string => Boolean(message)), terminal);
      };
      if (typeof child.stdout?.setEncoding === 'function') child.stdout.setEncoding('utf8');
      if (typeof child.stderr?.setEncoding === 'function') child.stderr.setEncoding('utf8');
      child.stdout?.on('data', consume);
      child.stderr?.on('data', (chunk: string) => { stderr += chunk; if (Buffer.byteLength(stderr, 'utf8') > 16_000) stderr = stderr.slice(-16_000); });
      child.once('error', (error) => { clearTimeout(timer); finishReject(error instanceof Error ? error : new Error('Codex conversation process failed.')); });
      child.once('close', (code: number | null) => {
        clearTimeout(timer);
        if (buffer.trim()) { const parsed = parseCodexJsonlEvents(`${buffer}\n`); if (parsed.codexThreadId) returned = parsed.codexThreadId; terminal = terminalMessage(parsed.events.map((event) => event.message).filter((message): message is string => Boolean(message)), terminal); }
        if (finished) return;
        if (timeoutError) { finishReject(timeoutError); return; }
        if (terminalError) { finishReject(terminalError); return; }
        if (code !== 0) { finishReject(new Error(stderr.trim() || `Codex exited with status ${code ?? 'unknown'}.`)); return; }
        if (!returned) { finishReject(new Error('Codex did not return a conversation identity.')); return; }
        finished = true; resolve({ returnedConversationId: returned, assistantOutput: terminal.trim() });
      });
    });
  }
}

function openBoundProjectRoot(binding: ProjectHumanThreadBinding): number {
  const lexical = lstatSync(binding.root.canonicalPath);
  if (!lexical.isDirectory() || lexical.isSymbolicLink()
    || String(lexical.dev) !== binding.root.dev || String(lexical.ino) !== binding.root.ino) {
    throw new Error('Project human thread root identity changed before writer lock.');
  }
  const fd = openSync(binding.root.canonicalPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const opened = fstatSync(fd);
  const final = lstatSync(binding.root.canonicalPath);
  if (!opened.isDirectory() || String(opened.dev) !== binding.root.dev || String(opened.ino) !== binding.root.ino
    || opened.dev !== final.dev || opened.ino !== final.ino || opened.mode !== final.mode) {
    closeSync(fd);
    throw new Error('Project human thread root identity changed before writer lock.');
  }
  return fd;
}
function readProcessStartTicks(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const end = stat.lastIndexOf(') ');
  if (end < 0) throw new Error('Project human thread worker identity is unavailable.');
  const startTicks = stat.slice(end + 2).trim().split(/\s+/)[19];
  if (!startTicks || !/^[1-9][0-9]*$/.test(startTicks)) throw new Error('Project human thread worker identity is unavailable.');
  return startTicks;
}
function safeCodexEnvironment(): NodeJS.ProcessEnv {
  const names = ['CODEX_HOME', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'SHELL', 'TERM', 'USER'];
  return Object.fromEntries(names.flatMap((name) => typeof process.env[name] === 'string' ? [[name, process.env[name]!]] : []));
}
function persistedFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : '';
  if (/timed out/i.test(raw)) return 'Codex conversation dispatch timed out; exact reconciliation is required.';
  if (/output is too large/i.test(raw)) return 'Codex conversation output exceeded the safe limit; exact reconciliation is required.';
  if (/conversation identity/i.test(raw)) return 'Codex conversation identity did not match the active project binding.';
  return 'Codex conversation dispatch failed; inspect the private server audit before retrying.';
}
function terminalMessage(messages: string[], prior: string): string { return messages.length ? messages[messages.length - 1]! : prior; }
