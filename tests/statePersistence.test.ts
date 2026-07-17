import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createJsonFilePersistence } from '../src/server/statePersistence';

describe('state persistence', () => {
  it('writes Roadex runtime state as mode 600 JSON and reloads it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadex-state-'));
    const path = join(dir, 'state.json');
    const persistence = createJsonFilePersistence(path);

    persistence.save({
      sessions: [],
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
});
