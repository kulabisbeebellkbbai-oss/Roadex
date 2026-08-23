import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync,
  readFileSync, realpathSync, unlinkSync, writeSync,
} from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { parse } from 'csv-parse/sync';
import { bootstrapControlledThread } from './projectThreadRegistrar.js';
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
  createControlledThread?: (projectRoot: string) => Promise<string>;
  registryPath?: string;
  launcherDirectory?: string;
  sessionExecutable?: string;
  tmuxExecutable?: string;
  runTmux?: typeof execFileSync;
};

type ThreadRow = { id: string; cwd: string; archived: number; created_at: number };

export class ProjectHumanThreadAuthority {
  readonly #stateDatabasePath: string;
  readonly #createControlledThread: (projectRoot: string) => Promise<string>;
  readonly #registryPath: string;
  readonly #launcherDirectory: string;
  readonly #sessionExecutable: string;
  readonly #tmuxExecutable: string;
  readonly #runTmux: typeof execFileSync;

  constructor(options: AuthorityOptions = {}) {
    const env = options.env ?? process.env;
    this.#stateDatabasePath = options.stateDatabasePath ?? env.CODEX_STATE_DATABASE ?? '/home/god/.codex/state_5.sqlite';
    this.#createControlledThread = options.createControlledThread
      ?? ((projectRoot) => bootstrapControlledThread(projectRoot, env));
    this.#registryPath = options.registryPath ?? env.ROADEX_CODEX_PROJECTS_REGISTRY ?? '/home/god/.codex/codex-projects.csv';
    this.#launcherDirectory = options.launcherDirectory ?? '/home/god/.local/bin';
    this.#sessionExecutable = options.sessionExecutable ?? '/home/god/.local/bin/codex-memory-session';
    this.#tmuxExecutable = options.tmuxExecutable ?? '/usr/bin/tmux';
    this.#runTmux = options.runTmux ?? execFileSync;
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
    const canonicalPath = this.#withRoot(projectRoot, (root) => root.canonicalPath);
    const conversationId = await this.#createControlledThread(canonicalPath);
    return this.inspect(canonicalPath, conversationId);
  }

  repair(binding: ProjectHumanThreadBinding): ProjectHumanThreadCandidate {
    const candidate = this.inspect(binding.root.canonicalPath, binding.conversationId);
    if (candidate.dev !== binding.root.dev || candidate.ino !== binding.root.ino) {
      throw new Error('Project human thread root identity changed.');
    }
    const command = `codex-${slugify(basename(candidate.canonicalPath))}-${candidate.conversationId.slice(0, 8)}`;
    const launcher = join(this.#launcherDirectory, command);
    const rows = this.#readRegistry();
    const exact = rows.filter((row) => row.conversation_id === candidate.conversationId);
    if (exact.length !== 1 || exact[0].project !== candidate.canonicalPath
      || exact[0].command !== command || exact[0].launcher !== launcher
      || rows.some((row) => row.command === command && row.conversation_id !== candidate.conversationId)) {
      throw new Error('Project human thread locator authority is unavailable.');
    }
    const content = launcherContent(
      this.#tmuxExecutable, this.#sessionExecutable, command, launcher,
      candidate.canonicalPath, candidate.dev, candidate.ino, candidate.conversationId,
    );
    this.#ensureLauncher(launcher, content);
    return candidate;
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
      && exact[0].source === 'registry+codex-state'
      && /^This is the dedicated Roadex human interaction thread for the .+ project\./.test(exact[0].label ?? '');
    if (!proven) return false;
    const expected = launcherContent(
      this.#tmuxExecutable, this.#sessionExecutable, command, launcher,
      candidate.canonicalPath, candidate.dev, candidate.ino, candidate.conversationId,
    );
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
function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
function launcherContent(
  tmux: string,
  sessionExecutable: string,
  command: string,
  launcher: string,
  projectRoot: string,
  dev: string,
  ino: string,
  conversationId: string,
): string {
  const worker = [launcher, '--worker'].map(shellQuote).join(' ');
  return `#!/usr/bin/python3
import fcntl
import os
import sys

ROOT = ${JSON.stringify(projectRoot)}
EXPECTED_DEV = ${JSON.stringify(dev)}
EXPECTED_INO = ${JSON.stringify(ino)}
TMUX = ${JSON.stringify(tmux)}
SESSION = ${JSON.stringify(sessionExecutable)}
COMMAND = ${JSON.stringify(command)}
CONVERSATION = ${JSON.stringify(conversationId)}
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
