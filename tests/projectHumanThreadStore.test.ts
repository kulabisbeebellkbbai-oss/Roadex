import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bindingDigest, type ProjectHumanThreadBinding } from '../src/shared/projectHumanThreadContracts';
import { ProjectHumanThreadStore } from '../src/server/projectHumanThreadStore';

function binding(overrides: Partial<ProjectHumanThreadBinding> = {}): ProjectHumanThreadBinding {
  const base = {
    schemaVersion: 'roadex.project-human-thread-binding.v1' as const,
    bindingId: 'project-human-thread:arcade:1', projectId: 'arcade',
    root: { canonicalPath: '/workspace/Arcade', dev: '254', ino: '12345' },
    purpose: 'human-interaction' as const,
    conversationId: '01a01569-7874-7f72-bca9-9c91bb869846', generation: 1,
    status: 'active' as const, predecessorGeneration: null,
    creationMode: 'created' as const, provenanceDigest: '1'.repeat(64),
    createdAt: '2026-08-22T12:00:00.000Z', updatedAt: '2026-08-22T12:00:00.000Z', retiredAt: null,
  };
  const value = { ...base, ...overrides };
  return { ...value, recordDigest: bindingDigest(value) } as ProjectHumanThreadBinding;
}

describe('ProjectHumanThreadStore', () => {
  it('migrates the pre-recovery event constraint without losing history', () => {
    const path = join(tmpdir(), `roadex-human-thread-v1-${randomUUID()}.sqlite`);
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE project_human_thread_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK(type IN ('created','unavailable','replacement-pending','replacement-activated')),
      project_id TEXT NOT NULL,generation INTEGER NOT NULL,payload_json TEXT NOT NULL,
      payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64),occurred_at TEXT NOT NULL
    );`);
    legacy.close();
    const store = new ProjectHumanThreadStore(path);
    const schema = new DatabaseSync(path, { readOnly: true });
    const sql = (schema.prepare("SELECT sql FROM sqlite_master WHERE name='project_human_thread_events'").get() as { sql: string }).sql;
    expect(sql).toContain("'recovered'");
    schema.close();
    store.close();
  });
  it('creates one active binding and replays only the exact idempotent request', () => {
    const store = new ProjectHumanThreadStore(':memory:');
    const first = store.createInitial(binding(), 'create:arcade:1');
    const replay = store.createInitial(binding(), 'create:arcade:1');
    expect(first).toEqual({ inserted: true, binding: binding() });
    expect(replay).toEqual({ inserted: false, replay: true, binding: binding() });
    expect(() => store.createInitial(binding({ conversationId: '01a01569-7874-7f72-bca9-9c91bb869847' }), 'create:arcade:1')).toThrow();
  });

  it('enforces project and conversation uniqueness under independent requests', () => {
    const store = new ProjectHumanThreadStore(':memory:');
    store.createInitial(binding(), 'create:arcade:1');
    expect(store.isBoundConversation(binding().conversationId)).toBe(true);
    expect(store.isBoundConversation('01a01569-7874-7f72-bca9-9c91bb869849')).toBe(false);
    expect(() => store.createInitial(binding({ conversationId: '01a01569-7874-7f72-bca9-9c91bb869847' }), 'create:arcade:2')).toThrow();
    expect(() => store.createInitial(binding({ bindingId: 'project-human-thread:other:1', projectId: 'other' }), 'create:other:1')).toThrow();
  });

  it('enforces one current human thread per durable root identity across project ids and paths', () => {
    const store = new ProjectHumanThreadStore(':memory:');
    store.createInitial(binding(), 'create:arcade:1');
    const alias = binding({
      bindingId: 'project-human-thread:alias:1', projectId: 'alias',
      root: { canonicalPath: '/workspace/Arcade-link', dev: '254', ino: '12345' },
      conversationId: '01a01569-7874-7f72-bca9-9c91bb869847',
    });
    expect(store.currentByRoot({ canonicalPath: '/workspace/Arcade', dev: '254', ino: '12345' })).toEqual(binding());
    expect(() => store.createInitial(alias, 'create:alias:1')).toThrow(/root/i);
  });

  it('marks unavailable and atomically replaces with immutable predecessor history', () => {
    const store = new ProjectHumanThreadStore(':memory:');
    store.createInitial(binding(), 'create:arcade:1');
    const unavailable = store.markUnavailable('arcade', 1, 'thread missing', '2026-08-22T12:10:00.000Z', 'unavailable:arcade:1');
    expect(unavailable.status).toBe('unavailable');
    const pending = store.beginReplacement('arcade', 1, 'user requested replacement', '2026-08-22T12:11:00.000Z', 'replacement:arcade:1');
    expect(pending.status).toBe('replacement-pending');
    const next = binding({
      bindingId: 'project-human-thread:arcade:2',
      conversationId: '01a01569-7874-7f72-bca9-9c91bb869847', generation: 2,
      predecessorGeneration: 1, createdAt: '2026-08-22T12:12:00.000Z', updatedAt: '2026-08-22T12:12:00.000Z',
    });
    store.activateReplacement(next, 1, 'activate:arcade:2');
    expect(store.isBoundConversation(binding().conversationId)).toBe(true);
    expect(store.isBoundConversation(next.conversationId)).toBe(true);
    expect(store.current('arcade')).toEqual(next);
    expect(store.history('arcade')).toMatchObject([
      { generation: 1, status: 'retired', retiredAt: '2026-08-22T12:12:00.000Z' },
      { generation: 2, status: 'active' },
    ]);
    expect(() => store.activateReplacement(binding({ generation: 3 }), 1, 'stale')).toThrow();
  });

  it('reopens durable state and rebuilds projections from append-only events', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'roadex-human-thread-')), 'state.sqlite');
    const first = new ProjectHumanThreadStore(path);
    first.createInitial(binding(), 'create:arcade:1');
    first.close();
    const reopened = new ProjectHumanThreadStore(path);
    expect(reopened.current('arcade')).toEqual(binding());
    reopened.rebuild();
    expect(reopened.current('arcade')).toEqual(binding());
  });

  it('fails closed when a legacy projection contains two current aliases for one root', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'roadex-human-thread-conflict-')), 'state.sqlite');
    const first = binding();
    const second = binding({
      bindingId: 'project-human-thread:alias:1', projectId: 'alias',
      conversationId: '01a01569-7874-7f72-bca9-9c91bb869847',
      root: { canonicalPath: '/workspace/Arcade-link', dev: '254', ino: '12345' },
    });
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE project_human_thread_bindings (
        project_id TEXT NOT NULL,generation INTEGER NOT NULL,conversation_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,binding_json TEXT NOT NULL,binding_digest TEXT NOT NULL,
        PRIMARY KEY(project_id,generation)
      );
      CREATE TABLE project_human_thread_current (
        project_id TEXT PRIMARY KEY,generation INTEGER NOT NULL,conversation_id TEXT NOT NULL UNIQUE
      );
    `);
    legacy.prepare('INSERT INTO project_human_thread_bindings VALUES (?,?,?,?,?,?)').run(
      first.projectId, first.generation, first.conversationId, first.status, JSON.stringify(first), first.recordDigest,
    );
    legacy.prepare('INSERT INTO project_human_thread_bindings VALUES (?,?,?,?,?,?)').run(
      second.projectId, second.generation, second.conversationId, second.status, JSON.stringify(second), second.recordDigest,
    );
    legacy.prepare('INSERT INTO project_human_thread_current VALUES (?,?,?)').run(first.projectId, first.generation, first.conversationId);
    legacy.prepare('INSERT INTO project_human_thread_current VALUES (?,?,?)').run(second.projectId, second.generation, second.conversationId);
    legacy.close();
    expect(() => new ProjectHumanThreadStore(path)).toThrow(/root identity conflict/i);
  });

  it('retains each lifecycle event in a durable relay outbox until its exact receipt', () => {
    const store = new ProjectHumanThreadStore(':memory:');
    store.createInitial(binding(), 'create:arcade:1');
    store.markUnavailable('arcade', 1, 'thread missing', '2026-08-22T12:10:00.000Z', 'unavailable:arcade:1');
    expect(store.pendingOutbox()).toMatchObject([
      { eventId: 'create:arcade:1', binding: { generation: 1, status: 'active' } },
      { eventId: 'unavailable:arcade:1', binding: { generation: 1, status: 'unavailable' } },
    ]);
    store.markOutboxDelivered('create:arcade:1');
    expect(store.pendingOutbox().map((item) => item.eventId)).toEqual(['unavailable:arcade:1']);
    expect(() => store.markOutboxDelivered('missing')).toThrow(/missing/i);
  });
});
