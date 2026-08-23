import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ProjectHumanThreadAuthority } from '../src/server/projectHumanThreadAuthority';
import { bindingDigest, type ProjectHumanThreadBinding } from '../src/shared/projectHumanThreadContracts';
import { projectHumanThreadLocator } from '../src/server/projectThreadRegistrar';

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

  it('resolves a symlink alias to the same canonical root identity', () => {
    const fixture = setup();
    const linked = join(fixture.root, 'Linked');
    symlinkSync(fixture.project, linked, 'dir');
    const authority = new ProjectHumanThreadAuthority({ stateDatabasePath: fixture.state });
    expect(authority.inspect(linked, threadId)).toMatchObject({ conversationId: threadId, canonicalPath: fixture.project });
    expect(authority.rootIdentity(linked)).toEqual(authority.rootIdentity(fixture.project));
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
    const candidate = new ProjectHumanThreadAuthority({ stateDatabasePath: fixture.state }).inspect(fixture.project, threadId);
    const locator = projectHumanThreadLocator({
      projectName: 'Arcade', projectRoot: fixture.project, conversationId: threadId,
      dev: candidate.dev, ino: candidate.ino, launcherDirectory: launchers,
      tmuxExecutable: '/usr/bin/tmux', sessionExecutable: '/safe/codex-memory-session',
    });
    const registry = join(fixture.root, 'codex-projects.csv');
    writeFileSync(registry, [
      'conversation_id,label,project,command,launcher,created_at,updated_at,source,notes',
      `${threadId},${locator.label},${fixture.project},${locator.command},${locator.launcher},,,${locator.source},`,
      '',
    ].join('\n'));
    chmodSync(registry, 0o600);
    const authority = new ProjectHumanThreadAuthority({
      stateDatabasePath: fixture.state, registryPath: registry, launcherDirectory: launchers,
      sessionExecutable: '/safe/codex-memory-session', tmuxExecutable: '/usr/bin/tmux',
      runTmux: () => { throw Object.assign(new Error('absent'), { status: 1, stderr: Buffer.from("can't find session: codex-arcade\n") }); },
    });
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
    expect(readFileSync(join(launchers, command), 'utf8')).toContain(`CONVERSATION = ${JSON.stringify(threadId)}`);
    expect(readFileSync(join(launchers, command), 'utf8')).toContain('fcntl.flock');
    expect(readFileSync(join(launchers, command), 'utf8')).toContain(`EXPECTED_DEV = ${JSON.stringify(candidate.dev)}`);
    expect(readFileSync(join(launchers, command), 'utf8')).toContain(`EXPECTED_INO = ${JSON.stringify(candidate.ino)}`);
    expect(authority.adoptableCandidates(fixture.project)).toEqual([candidate]);
    writeFileSync(join(launchers, command), '#!/bin/sh\nexec false\n');
    expect(() => authority.repair(binding)).toThrow(/launcher/);
  });

  it('treats exact tmux absence and no-server outcomes as quiescent while other failures remain fail-closed', () => {
    const fixture = setup();
    const candidate = new ProjectHumanThreadAuthority({ stateDatabasePath: fixture.state }).inspect(fixture.project, threadId);
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
    const absent = Object.assign(new Error('absent'), { status: 1, stderr: Buffer.from("can't find session: codex-arcade\n") });
    const noServer = Object.assign(new Error('no server'), { status: 1, stderr: Buffer.from('no server running on /tmp/tmux-1000/default\n') });
    const unavailable = Object.assign(new Error('denied'), { status: 1, stderr: Buffer.from('permission denied\n') });
    expect(new ProjectHumanThreadAuthority({ stateDatabasePath: fixture.state, runTmux: () => { throw absent; } }).hasLiveLocator(binding)).toBe(false);
    expect(new ProjectHumanThreadAuthority({ stateDatabasePath: fixture.state, runTmux: () => { throw noServer; } }).hasLiveLocator(binding)).toBe(false);
    expect(new ProjectHumanThreadAuthority({ stateDatabasePath: fixture.state, runTmux: () => { throw unavailable; } }).hasLiveLocator(binding)).toBe(true);
    expect(new ProjectHumanThreadAuthority({ stateDatabasePath: fixture.state, runTmux: () => Buffer.from('') }).hasLiveLocator(binding)).toBe(true);
  });

  it('durably retires the exact legacy locator and drains its writer before replacement', () => {
    const fixture = setup();
    const launchers = join(fixture.root, 'bin'); mkdirSync(launchers); chmodSync(launchers, 0o700);
    const command = `codex-arcade-${threadId.slice(0, 8)}`;
    const launcher = join(launchers, command);
    const registry = join(fixture.root, 'codex-projects.csv');
    writeFileSync(registry, [
      'conversation_id,label,project,command,launcher,created_at,updated_at,source,notes',
      `${threadId},This is the dedicated Roadex human interaction thread for the Arcade project. Do,${fixture.project},${command},${launcher},,,registry+codex-state,`,
      '',
    ].join('\n'));
    chmodSync(registry, 0o600);
    writeFileSync(launcher, `#!/usr/bin/env bash\nset -euo pipefail\n\nexec /usr/bin/tmux new-session -A -s ${command} -c ${fixture.project} '/safe/codex-memory-session resume ${threadId} --cd ${fixture.project}'\n`);
    chmodSync(launcher, 0o755);
    let live = true;
    let retiredMarker = '';
    let processName = 'codex';
    const calls: string[][] = [];
    const authority = new ProjectHumanThreadAuthority({
      stateDatabasePath: fixture.state, registryPath: registry, launcherDirectory: launchers,
      sessionExecutable: '/safe/codex-memory-session', tmuxExecutable: '/usr/bin/tmux',
      runTmux: ((_file: string, args: string[]) => {
        calls.push(args);
        if (args[0] === 'kill-session') { live = false; return Buffer.from(''); }
        if (args[0] === 'new-session') { live = true; processName = 'sleep'; return Buffer.from(''); }
        if (args[0] === 'set-option') { retiredMarker = args.at(-1) ?? ''; return Buffer.from(''); }
        if (args[0] === 'show-options') {
          if (live && retiredMarker) return Buffer.from(`${retiredMarker}\n`);
          throw Object.assign(new Error('missing option'), { status: 1, stderr: Buffer.from('unknown option\n') });
        }
        if (args[0] === 'list-panes') return Buffer.from(`${processName}\n`);
        if (args[0] === 'has-session' && live) return Buffer.from('');
        throw Object.assign(new Error('absent'), { status: 1, stderr: Buffer.from(`can't find session: ${command}\n`) });
      }) as typeof import('node:child_process').execFileSync,
      retireControlledThread: () => {
        if (readFileSync(launcher, 'utf8') === `# retired Roadex human interaction thread ${threadId}\n`) return;
        writeFileSync(launcher, `# retired Roadex human interaction thread ${threadId}\n`);
        chmodSync(launcher, 0o444);
      },
    });
    const candidate = authority.inspect(fixture.project, threadId);
    const value = {
      schemaVersion: 'roadex.project-human-thread-binding.v1' as const,
      bindingId: 'project-human-thread:arcade:1', projectId: 'arcade',
      root: { canonicalPath: fixture.project, dev: candidate.dev, ino: candidate.ino },
      purpose: 'human-interaction' as const, conversationId: threadId, generation: 1,
      status: 'replacement-pending' as const, predecessorGeneration: null, creationMode: 'adopted' as const,
      provenanceDigest: 'a'.repeat(64), createdAt: '2026-08-22T12:00:00.000Z',
      updatedAt: '2026-08-22T12:00:01.000Z', retiredAt: null,
    };
    const binding: ProjectHumanThreadBinding = { ...value, recordDigest: bindingDigest(value) };
    expect(() => authority.prepareReplacement(binding)).not.toThrow();
    expect(() => authority.prepareReplacement(binding)).not.toThrow();
    expect(readFileSync(launcher, 'utf8')).toContain('retired Roadex human interaction thread');
    expect(calls.filter((args) => args[0] === 'kill-session')).toHaveLength(1);
  });
});
