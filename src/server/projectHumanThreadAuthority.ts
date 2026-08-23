import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync,
  readFileSync, realpathSync, unlinkSync, writeSync,
} from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { parse } from 'csv-parse/sync';
import {
  bootstrapControlledThread,
  projectHumanThreadLocator,
  PROJECT_HUMAN_THREAD_SOURCE,
  readBootstrapReceipt,
  registerControlledHumanThread,
  retireControlledHumanThread,
} from './projectThreadRegistrar.js';
import type { ProjectHumanThreadBinding } from '../shared/projectHumanThreadContracts.js';

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ProjectHumanThreadCandidate = {
  conversationId: string;
  canonicalPath: string;
  dev: string;
  ino: string;
  createdAt: number;
};

export type ProjectHumanThreadCreateFailure = Error & {
  createEffect: 'none' | 'ambiguous';
};

/** Only an explicit typed `createEffect: 'none'` proof permits create retry. */
export function isProjectHumanThreadCreateNoSideEffect(error: unknown): error is ProjectHumanThreadCreateFailure {
  return error instanceof Error
    && (error as Partial<ProjectHumanThreadCreateFailure>).createEffect === 'none';
}

type AuthorityOptions = {
  stateDatabasePath?: string;
  env?: NodeJS.ProcessEnv;
  createControlledThread?: (projectRoot: string, operationId?: string) => Promise<string>;
  registryPath?: string;
  launcherDirectory?: string;
  sessionExecutable?: string;
  tmuxExecutable?: string;
  runTmux?: typeof execFileSync;
  retireControlledThread?: (binding: ProjectHumanThreadBinding) => void;
};

type ThreadRow = { id: string; cwd: string; archived: number; created_at: number };

export class ProjectHumanThreadAuthority {
  readonly #stateDatabasePath: string;
  readonly #createControlledThread: (projectRoot: string, operationId?: string) => Promise<string>;
  readonly #env: NodeJS.ProcessEnv;
  readonly #registerControlledThread: (candidate: ProjectHumanThreadCandidate) => Promise<void>;
  readonly #registryPath: string;
  readonly #launcherDirectory: string;
  readonly #sessionExecutable: string;
  readonly #tmuxExecutable: string;
  readonly #runTmux: typeof execFileSync;
  readonly #retireControlledThread: (binding: ProjectHumanThreadBinding) => void;
  readonly #requiresRegistrarProof: boolean;

  constructor(options: AuthorityOptions = {}) {
    const env = options.env ?? process.env;
    this.#env = env;
    this.#stateDatabasePath = options.stateDatabasePath ?? env.CODEX_STATE_DATABASE ?? '/home/god/.codex/state_5.sqlite';
    this.#createControlledThread = options.createControlledThread
      ?? ((projectRoot, operationId) => bootstrapControlledThread(projectRoot, env, operationId));
    this.#registerControlledThread = options.createControlledThread
      ? async () => undefined
      : async (candidate) => registerControlledHumanThread(
        candidate.canonicalPath, candidate.conversationId, env,
      );
    this.#requiresRegistrarProof = !options.createControlledThread;
    this.#registryPath = options.registryPath ?? env.ROADEX_CODEX_PROJECTS_REGISTRY ?? '/home/god/.codex/codex-projects.csv';
    this.#launcherDirectory = options.launcherDirectory ?? '/home/god/.local/bin';
    this.#sessionExecutable = options.sessionExecutable ?? '/home/god/.local/bin/codex-memory-session';
    this.#tmuxExecutable = options.tmuxExecutable ?? '/usr/bin/tmux';
    this.#runTmux = options.runTmux ?? execFileSync;
    this.#retireControlledThread = options.retireControlledThread
      ?? ((binding) => retireControlledHumanThread({
        projectId: binding.projectId,
        projectRoot: binding.root.canonicalPath,
        conversationId: binding.conversationId,
        generation: binding.generation,
      }, env));
  }

  rootIdentity(projectRoot: string): { canonicalPath: string; dev: string; ino: string } {
    return this.#withRoot(projectRoot, (root) => root);
  }

  inspect(projectRoot: string, conversationId: string): ProjectHumanThreadCandidate {
    if (!CONVERSATION_ID.test(conversationId)) throw new Error('Project human thread conversation identity is invalid.');
    return this.#withRoot(projectRoot, (root) => {
      const db = new DatabaseSync(this.#stateDatabasePath, { readOnly: true });
      try {
        const row = db.prepare('SELECT id,cwd,archived,created_at FROM threads WHERE id=?').get(conversationId) as ThreadRow | undefined;
        if (!row || row.archived !== 0) throw new Error('Project human thread is unavailable.');
        if (row.cwd !== root.canonicalPath) throw new Error('Project human thread does not bind the canonical project root.');
        return { conversationId: row.id, ...root, createdAt: Number(row.created_at) };
      } finally { db.close(); }
    });
  }

  candidates(projectRoot: string): ProjectHumanThreadCandidate[] {
    return this.#withRoot(projectRoot, (root) => {
      const db = new DatabaseSync(this.#stateDatabasePath, { readOnly: true });
      try {
        const rows = db.prepare(`
          SELECT id,cwd,archived,created_at FROM threads
          WHERE cwd=? AND archived=0 ORDER BY created_at,id
        `).all(root.canonicalPath) as unknown as ThreadRow[];
        return rows.filter((row) => CONVERSATION_ID.test(row.id)).map((row) => ({
          conversationId: row.id, ...root, createdAt: Number(row.created_at),
        }));
      } finally { db.close(); }
    });
  }

  adoptableCandidates(projectRoot: string): ProjectHumanThreadCandidate[] {
    const canonicalPath = this.#withRoot(projectRoot, (root) => root.canonicalPath);
    let rows: Array<Record<string, string>>;
    try { rows = this.#readRegistry(); } catch { return []; }
    return this.candidates(canonicalPath).filter((candidate) => (
      this.#hasHumanInteractionProvenance(rows, candidate)
      && !this.#locatorIsLive(locatorCommand(candidate.canonicalPath, candidate.conversationId))
    ));
  }

  inspectAdoptable(projectRoot: string, conversationId: string): ProjectHumanThreadCandidate {
    const candidate = this.inspect(projectRoot, conversationId);
    const exact = this.adoptableCandidates(candidate.canonicalPath)
      .find((item) => item.conversationId === conversationId);
    if (!exact) throw new Error('Project human thread candidate lacks durable human-interaction provenance or is not quiescent.');
    return exact;
  }

  async create(projectRoot: string): Promise<ProjectHumanThreadCandidate> {
    const candidate = await this.bootstrap(projectRoot);
    return await this.registerCreated(candidate);
  }

  async bootstrap(projectRoot: string, operationId?: string): Promise<ProjectHumanThreadCandidate> {
    const canonicalPath = this.#withRoot(projectRoot, (root) => root.canonicalPath);
    const conversationId = await this.#createControlledThread(canonicalPath, operationId);
    return this.inspect(canonicalPath, conversationId);
  }

  recoverBootstrap(projectRoot: string, operationId: string): ProjectHumanThreadCandidate | undefined {
    const canonicalPath = this.#withRoot(projectRoot, (root) => root.canonicalPath);
    const conversationId = readBootstrapReceipt(operationId, canonicalPath, this.#env);
    return conversationId ? this.inspect(canonicalPath, conversationId) : undefined;
  }

  async registerCreated(candidate: ProjectHumanThreadCandidate): Promise<ProjectHumanThreadCandidate> {
    const inspected = this.inspect(candidate.canonicalPath, candidate.conversationId);
    if (inspected.dev !== candidate.dev || inspected.ino !== candidate.ino) {
      throw new Error('Project human thread created identity changed.');
    }
    await this.#registerControlledThread(inspected);
    return this.#requiresRegistrarProof
      ? this.inspectAdoptable(inspected.canonicalPath, inspected.conversationId)
      : this.inspect(inspected.canonicalPath, inspected.conversationId);
  }

  repair(binding: ProjectHumanThreadBinding): ProjectHumanThreadCandidate {
    const candidate = this.inspect(binding.root.canonicalPath, binding.conversationId);
    if (candidate.dev !== binding.root.dev || candidate.ino !== binding.root.ino) {
      throw new Error('Project human thread root identity changed.');
    }
    const locator = this.#locator(candidate);
    const { command, launcher } = locator;
    const rows = this.#readRegistry();
    const exact = rows.filter((row) => row.conversation_id === candidate.conversationId);
    if (exact.length !== 1 || exact[0].project !== candidate.canonicalPath
      || exact[0].command !== command || exact[0].launcher !== launcher
      || rows.some((row) => row.command === command && row.conversation_id !== candidate.conversationId)) {
      throw new Error('Project human thread locator authority is unavailable.');
    }
    this.#ensureLauncher(launcher, locator.content);
    return candidate;
  }

  /**
   * Make the exact predecessor locator inert and prove its tmux writer absent
   * before a replacement thread may be bootstrapped. This operation is
   * intentionally idempotent so a durable replacement intent can resume after
   * any process crash boundary.
   */
  prepareReplacement(binding: ProjectHumanThreadBinding): void {
    if (binding.status !== 'replacement-pending') throw new Error('Project human thread replacement handoff is unavailable.');
    this.#requireConversationPath(binding.root.canonicalPath, binding.conversationId);
    const command = locatorCommand(binding.root.canonicalPath, binding.conversationId);
    const launcher = join(this.#launcherDirectory, command);
    const rows = this.#readRegistry();
    const exact = rows.filter((row) => row.conversation_id === binding.conversationId);
    if (exact.length !== 1 || exact[0].project !== binding.root.canonicalPath
      || exact[0].command !== command || exact[0].launcher !== launcher) {
      throw new Error('Project human thread predecessor locator authority is unavailable.');
    }
    const retired = retiredLauncherContent(binding.conversationId);
    this.#retireControlledThread(binding);
    if (this.#secureLauncherContent(launcher) !== retired) {
      throw new Error('Project human thread predecessor launcher retirement is unavailable.');
    }
    this.#ensureRetiredTombstone(command, `${binding.conversationId}:${binding.generation}`);
  }

  #requireConversationPath(projectRoot: string, conversationId: string): void {
    const db = new DatabaseSync(this.#stateDatabasePath, { readOnly: true });
    try {
      const row = db.prepare('SELECT id,cwd,archived,created_at FROM threads WHERE id=?').get(conversationId) as ThreadRow | undefined;
      if (!row || row.archived !== 0 || row.cwd !== projectRoot) {
        throw new Error('Project human thread predecessor does not bind the recorded project path.');
      }
    } finally { db.close(); }
  }

  /**
   * A dedicated Roadex dispatcher may write only when the exact managed tmux
   * locator is not already live. Any inability to prove that fact is treated
   * as live so a second writer can never be started accidentally.
   */
  hasLiveLocator(binding: ProjectHumanThreadBinding): boolean {
    if (binding.status !== 'active') return true;
    const command = locatorCommand(binding.root.canonicalPath, binding.conversationId);
    return this.#locatorIsLive(command);
  }

  #locatorIsLive(command: string): boolean {
    try {
      this.#runTmux(this.#tmuxExecutable, ['has-session', '-t', `=${command}`], {
        stdio: ['ignore', 'ignore', 'pipe'], timeout: 2_000,
      });
      return true;
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { status?: number | null; stderr?: Buffer | string };
      const stderr = String(failure.stderr ?? '').trim();
      if (failure.status === 1 && (
        /^can't find session: [A-Za-z0-9._:-]+$/.test(stderr)
        || /^no server running on \/[^\n]+$/.test(stderr)
      )) {
        return false;
      }
      return true;
    }
  }

  #hasHumanInteractionProvenance(rows: Array<Record<string, string>>, candidate: ProjectHumanThreadCandidate): boolean {
    const command = locatorCommand(candidate.canonicalPath, candidate.conversationId);
    const launcher = join(this.#launcherDirectory, command);
    const exact = rows.filter((row) => row.conversation_id === candidate.conversationId);
    const proven = exact.length === 1
      && exact[0].project === candidate.canonicalPath
      && exact[0].command === command
      && exact[0].launcher === launcher
      && exact[0].source === PROJECT_HUMAN_THREAD_SOURCE
      && exact[0].label === this.#locator(candidate).label;
    if (!proven) return false;
    const expected = this.#locator(candidate).content;
    try {
      const lexical = lstatSync(launcher);
      if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.nlink !== 1
        || lexical.uid !== process.getuid?.() || (lexical.mode & 0o777) !== 0o755) return false;
      const fd = openSync(launcher, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd);
        return opened.dev === lexical.dev && opened.ino === lexical.ino && readFileSync(fd, 'utf8') === expected;
      } finally { closeSync(fd); }
    } catch {
      return false;
    }
  }

  #locator(candidate: ProjectHumanThreadCandidate) {
    return projectHumanThreadLocator({
      projectName: basename(candidate.canonicalPath),
      projectRoot: candidate.canonicalPath,
      conversationId: candidate.conversationId,
      dev: candidate.dev,
      ino: candidate.ino,
      launcherDirectory: this.#launcherDirectory,
      tmuxExecutable: this.#tmuxExecutable,
      sessionExecutable: this.#sessionExecutable,
    });
  }

  #readRegistry(): Array<Record<string, string>> {
    const lexical = lstatSync(this.#registryPath);
    if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.nlink !== 1
      || lexical.uid !== process.getuid?.() || (lexical.mode & 0o022) !== 0 || lexical.size > 2_097_152) {
      throw new Error('Project human thread locator registry is unsafe.');
    }
    const fd = openSync(this.#registryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== lexical.dev || opened.ino !== lexical.ino) throw new Error('Project human thread locator registry changed.');
      const rows = parse(readFileSync(fd, 'utf8'), { columns: true, bom: true, skip_empty_lines: true }) as Array<Record<string, string>>;
      if (rows.length > 5_000) throw new Error('Project human thread locator registry is too large.');
      const final = lstatSync(this.#registryPath);
      if (final.dev !== opened.dev || final.ino !== opened.ino || final.size !== opened.size) {
        throw new Error('Project human thread locator registry changed.');
      }
      return rows;
    } finally { closeSync(fd); }
  }

  #ensureLauncher(path: string, content: string): void {
    const directory = lstatSync(this.#launcherDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.()
      || (directory.mode & 0o022) !== 0 || realpathSync(this.#launcherDirectory) !== this.#launcherDirectory) {
      throw new Error('Project human thread launcher directory is unsafe.');
    }
    try {
      const lexical = lstatSync(path);
      if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.nlink !== 1
        || lexical.uid !== process.getuid?.() || (lexical.mode & 0o777) !== 0o755) {
        throw new Error('Project human thread launcher is unsafe.');
      }
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd);
        if (opened.dev !== lexical.dev || opened.ino !== lexical.ino || readFileSync(fd, 'utf8') !== content) {
          throw new Error('Project human thread launcher conflicts with immutable identity.');
        }
      } finally { closeSync(fd); }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o700);
    try {
      writeSync(fd, content);
      fsyncSync(fd);
      fchmodSync(fd, 0o755);
      const opened = fstatSync(fd);
      const lexical = lstatSync(path);
      if (opened.dev !== lexical.dev || opened.ino !== lexical.ino || lexical.nlink !== 1) {
        throw new Error('Project human thread launcher publication failed.');
      }
      const directoryFd = openSync(this.#launcherDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    } catch (error) {
      try { unlinkSync(path); } catch { /* best effort rollback of operation-created locator */ }
      throw error;
    } finally { closeSync(fd); }
  }

  #secureLauncherContent(path: string): string {
    const lexical = lstatSync(path);
    if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.nlink !== 1
      || lexical.uid !== process.getuid?.() || ![0o755, 0o444].includes(lexical.mode & 0o777)) {
      throw new Error('Project human thread launcher is unsafe.');
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== lexical.dev || opened.ino !== lexical.ino) throw new Error('Project human thread launcher changed.');
      return readFileSync(fd, 'utf8');
    } finally { closeSync(fd); }
  }

  #ensureRetiredTombstone(command: string, marker: string): void {
    if (this.#retiredTombstoneMatches(command, marker)) return;
    if (this.#locatorIsLive(command)) this.#killLocator(command);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.#runTmux(this.#tmuxExecutable, [
          'new-session', '-d', '-s', command, '/usr/bin/sleep', '2147483647',
        ], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 2_000 });
      } catch {
        if (attempt === 1 || !this.#locatorIsLive(command)) {
          throw new Error('Project human thread predecessor tombstone could not be created.');
        }
        this.#killLocator(command);
        continue;
      }
      this.#runTmux(this.#tmuxExecutable, [
        'set-option', '-t', `=${command}`, '@roadex-human-thread-retired', marker,
      ], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 2_000 });
      if (this.#retiredTombstoneMatches(command, marker)) return;
      this.#killLocator(command);
    }
    throw new Error('Project human thread predecessor tombstone is unavailable.');
  }

  #retiredTombstoneMatches(command: string, marker: string): boolean {
    try {
      const value = String(this.#runTmux(this.#tmuxExecutable, [
        'show-options', '-v', '-t', `=${command}`, '@roadex-human-thread-retired',
      ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 2_000 })).trim();
      const processName = String(this.#runTmux(this.#tmuxExecutable, [
        'list-panes', '-t', `=${command}`, '-F', '#{pane_current_command}',
      ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 2_000 })).trim();
      return value === marker && processName === 'sleep';
    } catch { return false; }
  }

  #killLocator(command: string): void {
    try {
      this.#runTmux(this.#tmuxExecutable, ['kill-session', '-t', `=${command}`], {
        stdio: ['ignore', 'ignore', 'pipe'], timeout: 2_000,
      });
    } catch {
      throw new Error('Project human thread predecessor writer could not be stopped.');
    }
  }

  #withRoot<T>(projectRoot: string, action: (root: Omit<ProjectHumanThreadCandidate, 'conversationId' | 'createdAt'>) => T): T {
    if (!isAbsolute(projectRoot) || projectRoot !== projectRoot.trim()) throw new Error('Project human thread root is invalid.');
    let canonicalPath: string;
    try { canonicalPath = realpathSync(projectRoot); } catch { throw new Error('Project human thread root is unavailable.'); }
    const lexical = lstatSync(canonicalPath);
    if (!lexical.isDirectory() || lexical.isSymbolicLink() || realpathSync(canonicalPath) !== canonicalPath) {
      throw new Error('Project human thread root is unsafe.');
    }
    const fd = openSync(canonicalPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      const current = lstatSync(canonicalPath);
      if (!opened.isDirectory() || current.isSymbolicLink()
        || opened.dev !== current.dev || opened.ino !== current.ino
        || opened.uid !== current.uid || opened.mode !== current.mode) {
        throw new Error('Project human thread root identity changed.');
      }
      const result = action({ canonicalPath, dev: String(opened.dev), ino: String(opened.ino) });
      const final = lstatSync(canonicalPath);
      const finalOpened = fstatSync(fd);
      if (final.dev !== finalOpened.dev || final.ino !== finalOpened.ino || final.mode !== finalOpened.mode) {
        throw new Error('Project human thread root identity changed.');
      }
      return result;
    } finally { closeSync(fd); }
  }
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'codex';
}
function locatorCommand(projectRoot: string, conversationId: string): string {
  return `codex-${slugify(basename(projectRoot))}-${conversationId.slice(0, 8)}`;
}
function retiredLauncherContent(conversationId: string): string {
  return `# retired Roadex human interaction thread ${conversationId}\n`;
}
