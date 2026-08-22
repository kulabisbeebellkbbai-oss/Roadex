import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { bootstrapControlledThread } from './projectThreadRegistrar.js';

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ProjectHumanThreadCandidate = {
  conversationId: string;
  canonicalPath: string;
  dev: string;
  ino: string;
  createdAt: number;
};

type AuthorityOptions = {
  stateDatabasePath?: string;
  env?: NodeJS.ProcessEnv;
  createControlledThread?: (projectRoot: string) => Promise<string>;
};

type ThreadRow = { id: string; cwd: string; archived: number; created_at: number };

export class ProjectHumanThreadAuthority {
  readonly #stateDatabasePath: string;
  readonly #createControlledThread: (projectRoot: string) => Promise<string>;

  constructor(options: AuthorityOptions = {}) {
    const env = options.env ?? process.env;
    this.#stateDatabasePath = options.stateDatabasePath ?? env.CODEX_STATE_DATABASE ?? '/home/god/.codex/state_5.sqlite';
    this.#createControlledThread = options.createControlledThread
      ?? ((projectRoot) => bootstrapControlledThread(projectRoot, env));
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

  async create(projectRoot: string): Promise<ProjectHumanThreadCandidate> {
    const canonicalPath = this.#withRoot(projectRoot, (root) => root.canonicalPath);
    const conversationId = await this.#createControlledThread(canonicalPath);
    return this.inspect(canonicalPath, conversationId);
  }

  #withRoot<T>(projectRoot: string, action: (root: Omit<ProjectHumanThreadCandidate, 'conversationId' | 'createdAt'>) => T): T {
    if (!isAbsolute(projectRoot) || projectRoot !== projectRoot.trim()) throw new Error('Project human thread root is invalid.');
    const lexical = lstatSync(projectRoot);
    if (!lexical.isDirectory() || lexical.isSymbolicLink() || realpathSync(projectRoot) !== projectRoot) {
      throw new Error('Project human thread root is unsafe.');
    }
    const fd = openSync(projectRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      const current = lstatSync(projectRoot);
      if (!opened.isDirectory() || current.isSymbolicLink()
        || opened.dev !== current.dev || opened.ino !== current.ino
        || opened.uid !== current.uid || opened.mode !== current.mode) {
        throw new Error('Project human thread root identity changed.');
      }
      const result = action({ canonicalPath: projectRoot, dev: String(opened.dev), ino: String(opened.ino) });
      const final = lstatSync(projectRoot);
      const finalOpened = fstatSync(fd);
      if (final.dev !== finalOpened.dev || final.ino !== finalOpened.ino || final.mode !== finalOpened.mode) {
        throw new Error('Project human thread root identity changed.');
      }
      return result;
    } finally { closeSync(fd); }
  }
}
