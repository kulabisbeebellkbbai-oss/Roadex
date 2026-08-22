import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ProjectHumanThreadAuthority } from '../src/server/projectHumanThreadAuthority';

const threadId = '01a01569-7874-7f72-bca9-9c91bb869846';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'roadex-thread-authority-'));
  const project = join(root, 'Arcade');
  mkdirSync(project);
  const state = join(root, 'state.sqlite');
  const db = new DatabaseSync(state);
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,cwd TEXT NOT NULL,archived INTEGER NOT NULL,created_at INTEGER NOT NULL)');
  db.prepare('INSERT INTO threads VALUES (?,?,0,?)').run(threadId, project, 1);
  db.close();
  return { root, project, state };
}

describe('ProjectHumanThreadAuthority', () => {
  it('verifies an exact active Codex thread and stable project root identity', () => {
    const fixture = setup();
    const authority = new ProjectHumanThreadAuthority({ stateDatabasePath: fixture.state });
    const candidate = authority.inspect(fixture.project, threadId);
    expect(candidate).toMatchObject({ conversationId: threadId, canonicalPath: fixture.project });
    expect(candidate.dev).toMatch(/^[0-9]+$/);
    expect(candidate.ino).toMatch(/^[1-9][0-9]*$/);
  });

  it('lists exact candidates without selecting one and rejects archived or wrong-root threads', () => {
    const fixture = setup();
    const db = new DatabaseSync(fixture.state);
    const second = '01a01569-7874-7f72-bca9-9c91bb869847';
    db.prepare('INSERT INTO threads VALUES (?,?,0,?)').run(second, fixture.project, 2);
    const archived = '01a01569-7874-7f72-bca9-9c91bb869848';
    db.prepare('INSERT INTO threads VALUES (?,?,1,?)').run(archived, fixture.project, 3);
    db.close();
    const authority = new ProjectHumanThreadAuthority({ stateDatabasePath: fixture.state });
    expect(authority.candidates(fixture.project).map((item) => item.conversationId)).toEqual([threadId, second]);
    expect(() => authority.inspect(fixture.project, archived)).toThrow(/unavailable/);
    expect(() => authority.inspect(fixture.root, threadId)).toThrow(/does not bind/);
  });

  it('rejects symlink roots and detects a substituted project directory', () => {
    const fixture = setup();
    const linked = join(fixture.root, 'Linked');
    symlinkSync(fixture.project, linked, 'dir');
    const authority = new ProjectHumanThreadAuthority({ stateDatabasePath: fixture.state });
    expect(() => authority.inspect(linked, threadId)).toThrow(/root/);
  });

  it('creates through the injected controlled creator and verifies the returned identity', async () => {
    const fixture = setup();
    const calls: string[] = [];
    const authority = new ProjectHumanThreadAuthority({
      stateDatabasePath: fixture.state,
      createControlledThread: async (root) => { calls.push(root); return threadId; },
    });
    await expect(authority.create(fixture.project)).resolves.toMatchObject({ conversationId: threadId });
    expect(calls).toEqual([fixture.project]);
  });
});
