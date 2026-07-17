import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditEvent, RoadexSession, StreamEvent } from '../shared/sessionContracts.js';

export type PersistedRoadexState = {
  sessions: RoadexSession[];
  streamEvents: StreamEvent[];
  auditEvents: AuditEvent[];
};

export type StatePersistence = {
  load: () => PersistedRoadexState;
  save: (state: PersistedRoadexState) => void;
};

export type RetentionOptions = {
  now?: number;
  maxSessions?: number;
  maxStreamEvents?: number;
  maxAuditEvents?: number;
  sessionRetentionMs?: number;
};

export function createMemoryPersistence(initial?: Partial<PersistedRoadexState>): StatePersistence {
  let state: PersistedRoadexState = {
    sessions: initial?.sessions ?? [],
    streamEvents: initial?.streamEvents ?? [],
    auditEvents: initial?.auditEvents ?? [],
  };
  return {
    load() {
      return cloneState(state);
    },
    save(next) {
      state = cloneState(next);
    },
  };
}

export function createJsonFilePersistence(
  path = process.env.ROADEX_STATE_PATH ?? 'data/roadex-state.json',
): StatePersistence {
  return {
    load() {
      try {
        return serializeState(JSON.parse(readFileSync(path, 'utf8')) as PersistedRoadexState);
      } catch {
        return emptyState();
      }
    },
    save(state) {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(serializeState(state), null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}

export function serializeState(state: Partial<PersistedRoadexState>, options: RetentionOptions = {}): PersistedRoadexState {
  return applyRetention(sanitizeState(state, options.now), options);
}

function sanitizeState(state: Partial<PersistedRoadexState>, now = Date.now()): PersistedRoadexState {
  const timestamp = new Date(now).toISOString();
  return {
    sessions: (state.sessions ?? []).map((session) => ({
      ...session,
      lifecycle: session.lifecycle === 'streaming' || session.lifecycle === 'pending' ? 'ready' : session.lifecycle,
      deviceBridge: 'disabled',
      createdAt: session.createdAt ?? timestamp,
      updatedAt: session.updatedAt ?? session.createdAt ?? timestamp,
    })),
    streamEvents: state.streamEvents ?? [],
    auditEvents: state.auditEvents ?? [],
  };
}

function applyRetention(state: PersistedRoadexState, options: RetentionOptions): PersistedRoadexState {
  const now = options.now ?? Date.now();
  const maxSessions = options.maxSessions ?? numberFromEnv('ROADEX_STATE_MAX_SESSIONS', 50);
  const maxStreamEvents = options.maxStreamEvents ?? numberFromEnv('ROADEX_STATE_MAX_STREAM_EVENTS', 500);
  const maxAuditEvents = options.maxAuditEvents ?? numberFromEnv('ROADEX_STATE_MAX_AUDIT_EVENTS', 500);
  const sessionRetentionMs = options.sessionRetentionMs ?? numberFromEnv('ROADEX_SESSION_RETENTION_MS', 2_592_000_000);
  const cutoff = now - sessionRetentionMs;
  const retainedSessionIds = new Set(
    state.sessions
      .filter((session) => {
        if (session.lifecycle === 'ready' || session.lifecycle === 'streaming' || session.lifecycle === 'paused') {
          return true;
        }
        return sessionTimestamp(session) >= cutoff;
      })
      .sort((left, right) => sessionTimestamp(right) - sessionTimestamp(left))
      .slice(0, maxSessions)
      .map((session) => session.id),
  );

  return {
    sessions: state.sessions.filter((session) => retainedSessionIds.has(session.id)),
    streamEvents: state.streamEvents
      .filter((event) => retainedSessionIds.has(event.sessionId))
      .slice(-maxStreamEvents),
    auditEvents: state.auditEvents.slice(-maxAuditEvents),
  };
}

function sessionTimestamp(session: RoadexSession): number {
  const parsed = Date.parse(session.updatedAt || session.createdAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function numberFromEnv(key: string, fallback: number): number {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function emptyState(): PersistedRoadexState {
  return {
    sessions: [],
    streamEvents: [],
    auditEvents: [],
  };
}

function cloneState(state: PersistedRoadexState): PersistedRoadexState {
  return JSON.parse(JSON.stringify(state)) as PersistedRoadexState;
}
