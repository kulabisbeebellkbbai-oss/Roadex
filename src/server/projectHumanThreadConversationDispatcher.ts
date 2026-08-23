import { spawn } from 'node:child_process';
import { closeSync, constants, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { buildCodexExecArgs, parseCodexJsonlEvents, parseCodexJsonlStream } from './codexRunner.js';
import type { ProjectHumanThreadBinding } from '../shared/projectHumanThreadContracts.js';
import type { ProjectHumanThreadTurn } from '../shared/projectHumanThreadConversationContracts.js';
import type { ProjectHumanThreadConversationStore } from './projectHumanThreadConversationStore.js';

type Authority = { current(projectId: string): ProjectHumanThreadBinding | undefined; hasLiveLocator(binding: ProjectHumanThreadBinding): boolean };
type Options = { executable?: string; spawnProcess?: typeof spawn; leaseDirectory?: string; timeoutMs?: number };

export class ProjectHumanThreadConversationDispatcher {
  readonly #store: ProjectHumanThreadConversationStore;
  readonly #authority: Authority;
  readonly #executable: string;
  readonly #spawn: typeof spawn;
  readonly #leaseDirectory: string;
  readonly #timeoutMs: number;

  constructor(store: ProjectHumanThreadConversationStore, authority: Authority, options: Options = {}) {
    this.#store = store; this.#authority = authority;
    this.#executable = options.executable ?? process.env.ROADEX_CODEX_BIN ?? 'codex';
    this.#spawn = options.spawnProcess ?? spawn;
    this.#leaseDirectory = options.leaseDirectory ?? process.env.ROADEX_PROJECT_HUMAN_THREAD_LEASE_DIRECTORY ?? 'data/project-human-thread-leases';
    this.#timeoutMs = options.timeoutMs ?? 120_000;
  }

  async dispatch(turnId: string): Promise<ProjectHumanThreadTurn> {
    const queued = this.#store.get(turnId);
    if (!queued) throw new Error('Project human thread turn is missing.');
    const binding = this.#authority.current(queued.projectId);
    if (!binding || binding.status !== 'active' || binding.generation !== queued.generation || binding.conversationId !== queued.conversationId) {
      const failed = this.#store.fail(turnId, 'The project human-thread binding changed before dispatch.', true);
      throw new Error(`Project human thread turn is reconciliation-required: ${failed.error}`);
    }
    const lease = acquireLease(this.#leaseDirectory, binding, turnId);
    if (!lease) {
      const failed = this.#store.fail(turnId, 'Another Roadex writer lease owns this project binding. Use controlled handoff or Replace binding; Roadex will not terminate it or create a second writer.', true);
      throw new Error(`Project human thread turn is reconciliation-required: ${failed.error}`);
    }
    try {
      if (this.#authority.hasLiveLocator(binding)) {
        const failed = this.#store.fail(turnId, 'A live writer already owns the exact project-thread locator. Use controlled handoff or Replace binding; Roadex will not terminate it or create a second writer.', true);
        throw new Error(`Project human thread turn is reconciliation-required: ${failed.error}`);
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
        const failed = this.#store.fail(turnId, error instanceof Error ? error.message : 'Codex conversation dispatch failed.', true);
        throw new Error(`Project human thread turn is reconciliation-required: ${failed.error}`);
      }
    } finally { lease.release(); }
  }

  async dispatchPending(): Promise<{ completed: number; failed: number }> {
    let completed = 0; let failed = 0;
    for (const turn of this.#store.pendingOutbox()) {
      try { await this.dispatch(turn.turnId); completed += 1; } catch { failed += 1; }
    }
    return { completed, failed };
  }

  async #run(turn: ProjectHumanThreadTurn, binding: ProjectHumanThreadBinding): Promise<{ returnedConversationId: string; assistantOutput: string }> {
    const projectRoot = binding.root.canonicalPath;
    const args = buildCodexExecArgs(projectRoot, turn.content, turn.conversationId);
    const child = this.#spawn(this.#executable, args, { cwd: projectRoot, env: safeCodexEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    return new Promise((resolve, reject) => {
      let buffer = ''; let stderr = ''; let bytes = 0; let returned: string | undefined; let terminal = ''; let finished = false;
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
        if (bytes > 64_000) { clearTimeout(timer); try { child.kill('SIGKILL'); } catch { /* best effort */ } finishReject(new Error('Codex conversation output is too large.')); return; }
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
        if (code !== 0) { finishReject(new Error(stderr.trim() || `Codex exited with status ${code ?? 'unknown'}.`)); return; }
        if (!returned) { finishReject(new Error('Codex did not return a conversation identity.')); return; }
        finished = true; resolve({ returnedConversationId: returned, assistantOutput: terminal.trim() });
      });
    });
  }
}

function acquireLease(directory: string, binding: ProjectHumanThreadBinding, turnId: string): { release: () => void } | undefined {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${binding.bindingId.replace(/[^A-Za-z0-9._:-]/g, '_')}.lock`);
  let fd: number;
  try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined; throw error; }
  writeSync(fd, `${process.pid}:${turnId}\n`); closeSync(fd);
  return { release: () => { try { unlinkSync(path); } catch { /* preserve an ambiguous lease on failure */ } } };
}
function safeCodexEnvironment(): NodeJS.ProcessEnv {
  const names = ['CODEX_HOME', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'SHELL', 'TERM', 'USER'];
  return Object.fromEntries(names.flatMap((name) => typeof process.env[name] === 'string' ? [[name, process.env[name]!]] : []));
}
function terminalMessage(messages: string[], prior: string): string { return messages.length ? messages[messages.length - 1]! : prior; }
