import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createJsonFilePersistence, serializeState } from '../src/server/statePersistence';
import type { RoadexSession, StreamEvent } from '../src/shared/sessionContracts';

describe('state persistence', () => {
  it('writes Roadex runtime state as mode 600 JSON and reloads it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadex-state-'));
    const path = join(dir, 'state.json');
    const persistence = createJsonFilePersistence(path);
    const session = sessionFixture('session-1', 'ready', new Date(0).toISOString());

    persistence.save({
      sessions: [session],
      streamEvents: [
        {
          id: 'event-1',
          sessionId: 'session-1',
          kind: 'system',
          message: 'persisted',
          at: new Date(0).toISOString(),
        },
      ],
      auditEvents: [],
    });

    expect(readFileSync(path, 'utf8')).toContain('persisted');
    expect(persistence.load().streamEvents).toHaveLength(1);
  });

  it('trims stale closed sessions and their transcript events during serialization', () => {
    const now = Date.UTC(2026, 6, 17);
    const fresh = sessionFixture('fresh', 'ready', new Date(now).toISOString());
    const archived = sessionFixture('archived', 'closed', new Date(now - 1_000).toISOString());
    const stale = sessionFixture('stale', 'closed', new Date(now - 10_000).toISOString());
    const state = serializeState(
      {
        sessions: [stale, archived, fresh],
        streamEvents: [
          streamEvent('stale-event', stale.id),
          streamEvent('archived-event', archived.id),
          streamEvent('fresh-event', fresh.id),
        ],
        auditEvents: [],
      },
      {
        now,
        sessionRetentionMs: 5_000,
        maxSessions: 5,
        maxStreamEvents: 5,
        maxAuditEvents: 5,
      },
    );

    expect(state.sessions.map((session) => session.id)).toEqual(['archived', 'fresh']);
    expect(state.streamEvents.map((event) => event.id)).toEqual(['archived-event', 'fresh-event']);
  });

  it('caps retained sessions, transcript events, and audit events', () => {
    const now = Date.UTC(2026, 6, 17);
    const sessions = ['one', 'two', 'three'].map((id, index) =>
      sessionFixture(id, 'closed', new Date(now + index).toISOString()),
    );
    const state = serializeState(
      {
        sessions,
        streamEvents: [
          streamEvent('event-one', 'one'),
          streamEvent('event-two', 'two'),
          streamEvent('event-three', 'three'),
        ],
        auditEvents: [
          {
            id: 'audit-one',
            at: new Date(now).toISOString(),
            actorId: 'user',
            action: 'session.close',
            resource: 'one',
            outcome: 'allowed',
            summary: 'one',
          },
          {
            id: 'audit-two',
            at: new Date(now).toISOString(),
            actorId: 'user',
            action: 'session.close',
            resource: 'two',
            outcome: 'allowed',
            summary: 'two',
          },
        ],
      },
      {
        now,
        maxSessions: 2,
        maxStreamEvents: 1,
        maxAuditEvents: 1,
        sessionRetentionMs: 60_000,
      },
    );

    expect(state.sessions.map((session) => session.id)).toEqual(['two', 'three']);
    expect(state.streamEvents.map((event) => event.id)).toEqual(['event-three']);
    expect(state.auditEvents.map((event) => event.id)).toEqual(['audit-two']);
  });
});

function sessionFixture(id: string, lifecycle: RoadexSession['lifecycle'], updatedAt: string): RoadexSession {
  return {
    id,
    userId: 'user',
    workspace: {
      id: 'roadex',
      name: 'Roadex Portal',
      root: '/srv/roadex',
    },
    lifecycle,
    runnerMode: 'codex',
    transport: 'sse',
    deviceBridge: 'disabled',
    gates: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

function streamEvent(id: string, sessionId: string): StreamEvent {
  return {
    id,
    sessionId,
    kind: 'system',
    message: id,
    at: new Date(0).toISOString(),
  };
}
