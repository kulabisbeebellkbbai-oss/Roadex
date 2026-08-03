import { createHash, createHmac, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { UserProfile } from '../shared/sessionContracts.js';
import {
  APP_PUBLICATION_CONTRACT_VERSION,
  type AppPublicationApiPathNeed,
  type AppPublicationHttpMethod,
  type AppPublicationPathNeed,
  type AppPublicationRequestPublic,
  type AppPublicationRequestSpec,
} from '../shared/appPublicationContracts.js';
import { appPublicationRequestEnabled } from './appPublicationPolicy.js';

type RequesterDependencies = {
  workspaceBelongsToProject: (
    userId: string,
    projectId: string,
    workspaceId: string,
  ) => boolean;
};

type RequesterOptions = {
  databasePath?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  createId?: () => string;
};

type RequestRow = {
  id: string;
  user_id: string;
  project_id: string;
  workspace_id: string;
  request_key_digest: string;
  spec_digest: string;
  spec_json: string;
  status: AppPublicationRequestPublic['status'];
  created_at: string;
  updated_at: string;
};

export type AppPublicationCreateResult =
  | { outcome: 'created'; request: AppPublicationRequestPublic }
  | { outcome: 'replayed'; request: AppPublicationRequestPublic }
  | { outcome: 'conflict' }
  | { outcome: 'denied' };

const METHODS = new Set<AppPublicationHttpMethod>([
  'GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS',
]);
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const REQUEST_KEY = /^[A-Za-z0-9._~-]{16,128}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,79}$/;
const SAFE_PATH = /^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?$/;

export class AppPublicationRequester {
  readonly #db: DatabaseSync;
  readonly #deps: RequesterDependencies;
  readonly #env: NodeJS.ProcessEnv;
  readonly #now: () => number;
  readonly #createId: () => string;

  constructor(dependencies: RequesterDependencies, options: RequesterOptions = {}) {
    this.#deps = dependencies;
    this.#env = options.env ?? process.env;
    this.#now = options.now ?? Date.now;
    this.#createId = options.createId ?? (() => `app-publication-${randomUUID()}`);
    this.#db = new DatabaseSync(
      options.databasePath
      ?? this.#env.ROADEX_APP_PUBLICATION_STATE_PATH
      ?? 'data/app-publication.sqlite',
    );
    this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS app_publication_requests (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        request_key_digest TEXT NOT NULL,
        spec_digest TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status='submitted'),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, workspace_id, request_key_digest)
      );
      CREATE TABLE IF NOT EXISTS app_publication_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        action TEXT NOT NULL,
        actor_tag TEXT NOT NULL,
        request_tag TEXT NOT NULL,
        outcome TEXT NOT NULL
      );
    `);
  }

  create(
    user: UserProfile,
    idempotencyKey: string | undefined,
    payload: unknown,
  ): AppPublicationCreateResult {
    if (!this.#authorized(user) || !idempotencyKey || !REQUEST_KEY.test(idempotencyKey)) {
      return { outcome: 'denied' };
    }
    const spec = parseAppPublicationSpec(payload);
    if (!spec || !this.#deps.workspaceBelongsToProject(
      user.id,
      spec.project.projectId,
      spec.workspace.workspaceId,
    )) return { outcome: 'denied' };

    const keyDigest = digest(idempotencyKey);
    const specJson = stableJson(spec);
    const specDigest = digest(specJson);
    const existing = this.#byKey(user.id, spec.workspace.workspaceId, keyDigest);
    if (existing) {
      if (existing.spec_digest !== specDigest) return { outcome: 'conflict' };
      return { outcome: 'replayed', request: publicRequest(existing) };
    }

    const now = new Date(this.#now()).toISOString();
    const row: RequestRow = {
      id: this.#createId(),
      user_id: user.id,
      project_id: spec.project.projectId,
      workspace_id: spec.workspace.workspaceId,
      request_key_digest: keyDigest,
      spec_digest: specDigest,
      spec_json: specJson,
      status: 'submitted',
      created_at: now,
      updated_at: now,
    };
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      this.#db.prepare(`
        INSERT INTO app_publication_requests VALUES (
          @id,@user_id,@project_id,@workspace_id,@request_key_digest,
          @spec_digest,@spec_json,@status,@created_at,@updated_at
        )
      `).run(row);
      this.#audit(user.id, row.id, 'request.create', 'submitted');
      this.#db.exec('COMMIT');
      return { outcome: 'created', request: publicRequest(row) };
    } catch {
      try { this.#db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      const raced = this.#byKey(user.id, spec.workspace.workspaceId, keyDigest);
      if (!raced) return { outcome: 'denied' };
      return raced.spec_digest === specDigest
        ? { outcome: 'replayed', request: publicRequest(raced) }
        : { outcome: 'conflict' };
    }
  }

  get(user: UserProfile, requestId: string): AppPublicationRequestPublic | undefined {
    if (!this.#authorized(user) || !REQUEST_ID.test(requestId)) return undefined;
    const row = this.#db.prepare(
      'SELECT * FROM app_publication_requests WHERE id=? AND user_id=?',
    ).get(requestId, user.id) as RequestRow | undefined;
    return row ? publicRequest(row) : undefined;
  }

  #authorized(user: UserProfile): boolean {
    if (!appPublicationRequestEnabled(this.#env) || user.authMode !== 'protected-gateway') return false;
    const auditKey = this.#env.ROADEX_APP_PUBLICATION_AUDIT_HMAC_KEY;
    if (!auditKey || Buffer.byteLength(auditKey) < 32) return false;
    const allowed = (this.#env.ROADEX_APP_PUBLICATION_AUTHORIZED_USERS ?? '')
      .split(',').map((value) => value.trim()).filter(Boolean);
    return allowed.includes(user.id);
  }

  #byKey(userId: string, workspaceId: string, keyDigest: string): RequestRow | undefined {
    return this.#db.prepare(`
      SELECT * FROM app_publication_requests
      WHERE user_id=? AND workspace_id=? AND request_key_digest=?
    `).get(userId, workspaceId, keyDigest) as RequestRow | undefined;
  }

  #audit(actorId: string, requestId: string, action: string, outcome: string): void {
    const key = this.#env.ROADEX_APP_PUBLICATION_AUDIT_HMAC_KEY!;
    const tag = (value: string) => createHmac('sha256', key).update(value).digest('hex').slice(0, 24);
    this.#db.prepare(`
      INSERT INTO app_publication_audit(at,action,actor_tag,request_tag,outcome)
      VALUES (?,?,?,?,?)
    `).run(new Date(this.#now()).toISOString(), action, tag(actorId), tag(requestId), outcome);
  }
}

export function parseAppPublicationSpec(value: unknown): AppPublicationRequestSpec | undefined {
  if (!exactObject(value, ['contractVersion', 'project', 'workspace', 'app', 'publication', 'rollback'])) return undefined;
  if (value.contractVersion !== APP_PUBLICATION_CONTRACT_VERSION) return undefined;
  if (!exactObject(value.project, ['projectId', 'projectName'])
    || !validId(value.project.projectId)
    || !safeName(value.project.projectName)) return undefined;
  if (!exactObject(value.workspace, ['workspaceId']) || !validId(value.workspace.workspaceId)) return undefined;
  if (!exactObject(value.app, ['name']) || !safeName(value.app.name)) return undefined;
  if (!exactObject(value.publication, [
    'routePrefix', 'backendUrl', 'allowedMethods', 'healthPath',
    'routeSelection', 'preserveFullPath', 'pathNeeds',
  ])) return undefined;
  const publication = value.publication;
  if (!validRoutePrefix(publication.routePrefix)
    || !validBackendUrl(publication.backendUrl)
    || publication.routeSelection !== 'longest-prefix'
    || publication.preserveFullPath !== true
    || !validPath(publication.healthPath)) return undefined;
  const allowedMethods = parseMethods(publication.allowedMethods);
  if (!allowedMethods || !exactObject(publication.pathNeeds, ['assets', 'apis'])) return undefined;
  const assets = parsePathNeeds(publication.pathNeeds.assets);
  const apis = parseApiPathNeeds(publication.pathNeeds.apis, allowedMethods);
  if (!assets || !apis) return undefined;
  if (!exactObject(value.rollback, ['mode', 'healthPath'], ['previousRequestId'])
    || !validRollbackMode(value.rollback.mode)
    || !validPath(value.rollback.healthPath)
    || value.rollback.healthPath !== publication.healthPath) return undefined;
  if (value.rollback.mode === 'restore-previous') {
    if (typeof value.rollback.previousRequestId !== 'string'
      || !REQUEST_ID.test(value.rollback.previousRequestId)) return undefined;
  } else if (value.rollback.previousRequestId !== undefined) return undefined;
  return value as AppPublicationRequestSpec;
}

function publicRequest(row: RequestRow): AppPublicationRequestPublic {
  return {
    id: row.id,
    contractVersion: APP_PUBLICATION_CONTRACT_VERSION,
    spec: JSON.parse(row.spec_json) as AppPublicationRequestSpec,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    gates: {
      gatewayReview: 'pending',
      idsReview: 'pending',
      activationApproval: 'pending',
    },
    gateway: {},
  };
}

function exactObject(
  value: unknown,
  required: string[],
  optional: string[] = [],
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function safeName(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && SAFE_NAME.test(value);
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

function validRollbackMode(value: unknown): value is 'disable-route' | 'restore-previous' {
  return value === 'disable-route' || value === 'restore-previous';
}

function validMatch(value: unknown): value is 'exact' | 'subtree' {
  return value === 'exact' || value === 'subtree';
}

function validPath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 256
    && SAFE_PATH.test(value)
    && !value.includes('//')
    && !/(?:^|\/)\.{1,2}(?:\/|$)/.test(value)
    && !/%(?:2f|5c|2e)/i.test(value)
    && !value.includes('?')
    && !value.includes('#')
    && (value === '/' || !value.endsWith('/'));
}

function validRoutePrefix(value: unknown): value is string {
  return validPath(value) && /^\/Roadex\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(value);
}

function validBackendUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 128) return false;
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return url.protocol === 'http:'
      && url.hostname === '127.0.0.1'
      && url.username === ''
      && url.password === ''
      && url.pathname === '/'
      && url.search === ''
      && url.hash === ''
      && Number.isInteger(port)
      && port >= 1
      && port <= 65_535
      && value === `http://127.0.0.1:${port}`;
  } catch {
    return false;
  }
}

function parseMethods(value: unknown): AppPublicationHttpMethod[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) return undefined;
  if (!value.every((item): item is AppPublicationHttpMethod => typeof item === 'string' && METHODS.has(item as AppPublicationHttpMethod))) return undefined;
  return new Set(value).size === value.length ? value : undefined;
}

function parsePathNeeds(value: unknown): AppPublicationPathNeed[] | undefined {
  if (!Array.isArray(value) || value.length > 32) return undefined;
  const parsed: AppPublicationPathNeed[] = [];
  for (const item of value) {
    if (!exactObject(item, ['path', 'match']) || !validPath(item.path)
      || !validMatch(item.match)) return undefined;
    parsed.push(item as AppPublicationPathNeed);
  }
  return uniqueNeeds(parsed) ? parsed : undefined;
}

function parseApiPathNeeds(
  value: unknown,
  allowed: AppPublicationHttpMethod[],
): AppPublicationApiPathNeed[] | undefined {
  if (!Array.isArray(value) || value.length > 32) return undefined;
  const parsed: AppPublicationApiPathNeed[] = [];
  for (const item of value) {
    if (!exactObject(item, ['path', 'match', 'methods']) || !validPath(item.path)
      || !validMatch(item.match)) return undefined;
    const methods = parseMethods(item.methods);
    if (!methods || methods.some((method) => !allowed.includes(method))) return undefined;
    parsed.push({ path: item.path, match: item.match, methods });
  }
  return uniqueNeeds(parsed) ? parsed : undefined;
}

function uniqueNeeds(value: Array<{ path: string; match: string }>): boolean {
  return new Set(value.map((item) => `${item.match}:${item.path}`)).size === value.length;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
