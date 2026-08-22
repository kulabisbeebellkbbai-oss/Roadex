import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ProjectHumanThreadAuthority } from '../src/server/projectHumanThreadAuthority';
import { bindingDigest, type ProjectHumanThreadBinding } from '../src/shared/projectHumanThreadContracts';

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

  it('recreates only the exact same-ID derived launcher from verified registry and state', () => {
    const fixture = setup();
    const launchers = join(fixture.root, 'bin'); mkdirSync(launchers); chmodSync(launchers, 0o700);
    const command = `codex-arcade-${threadId.slice(0, 8)}`;
    const registry = join(fixture.root, 'codex-projects.csv');
    writeFileSync(registry, [
      'conversation_id,label,project,command,launcher,created_at,updated_at,source,notes',
      `${threadId},Arcade,${fixture.project},${command},${join(launchers, command)},,,,`,
      '',
    ].join('\n'));
    chmodSync(registry, 0o600);
    const authority = new ProjectHumanThreadAuthority({
      stateDatabasePath: fixture.state, registryPath: registry, launcherDirectory: launchers,
      sessionExecutable: '/safe/codex-memory-session', tmuxExecutable: '/usr/bin/tmux',
    });
    const candidate = authority.inspect(fixture.project, threadId);
    const value = {
      schemaVersion: 'roadex.project-human-thread-binding.v1' as const,
      bindingId: 'project-human-thread:arcade:1', projectId: 'arcade',
      root: { canonicalPath: fixture.project, dev: candidate.dev, ino: candidate.ino },
      purpose: 'human-interaction' as const, conversationId: threadId, generation: 1,
      status: 'active' as const, predecessorGeneration: null, creationMode: 'adopted' as const,
      provenanceDigest: 'a'.repeat(64), createdAt: '2026-08-22T12:00:00.000Z',
      updatedAt: '2026-08-22T12:00:00.000Z', retiredAt: null,
    };
    const binding: ProjectHumanThreadBinding = { ...value, recordDigest: bindingDigest(value) };
    expect(authority.repair(binding)).toMatchObject({ conversationId: threadId });
    expect(readFileSync(join(launchers, command), 'utf8')).toContain(`resume ${threadId} --cd`);
    writeFileSync(join(launchers, command), '#!/bin/sh\nexec false\n');
    expect(() => authority.repair(binding)).toThrow(/launcher/);
  });
});
