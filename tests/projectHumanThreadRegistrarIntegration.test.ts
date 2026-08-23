import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ProjectHumanThreadAuthority } from '../src/server/projectHumanThreadAuthority';
import { ProjectHumanThreadService } from '../src/server/projectHumanThreadService';
import { ProjectHumanThreadStore } from '../src/server/projectHumanThreadStore';

const manager = '/home/god/codex_project_manager.py';

describe('project human thread registrar integration', () => {
  it('registers one locked human-purpose locator that can be adopted and recovered', async () => {
    const base = mkdtempSync(join(tmpdir(), 'roadex-human-registrar-'));
    const workspace = join(base, 'workspace');
    const project = join(workspace, 'Imported Arcade');
    const registryDirectory = join(base, 'state');
    const launcherDirectory = join(base, 'bin');
    mkdirSync(project, { recursive: true });
    mkdirSync(registryDirectory);
    mkdirSync(launcherDirectory);
    chmodSync(registryDirectory, 0o700);
    chmodSync(launcherDirectory, 0o700);
    const state = join(base, 'state.sqlite');
    const conversationId = '01a01569-7874-7f72-bca9-9c91bb869846';
    const db = new DatabaseSync(state);
    db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,cwd TEXT NOT NULL,archived INTEGER NOT NULL,created_at INTEGER NOT NULL)');
    db.prepare('INSERT INTO threads VALUES (?,?,0,?)').run(conversationId, project, 1);
    db.close();

    const operationId = `human-thread-operation-${conversationId}`;
    const projectIdentityDigest = createHash('sha256').update('approved imported project').digest('hex');
    const key = 'k'.repeat(32);
    const binding = JSON.stringify({
      operationId, projectIdentityDigest, projectRoot: project, threadId: conversationId,
    });
    const request = {
      operation_id: operationId,
      project_root: project,
      thread_id: conversationId,
      project_identity_digest: projectIdentityDigest,
      bootstrap_binding: createHmac('sha256', key).update(binding).digest('hex'),
    };
    const registry = join(registryDirectory, 'codex-projects.csv');
    const audit = join(registryDirectory, 'audit.jsonl');
    const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("codex_project_manager", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
request = json.loads(sys.argv[2])
paths = module.RegistrarPaths(workspace_root=module.Path(sys.argv[3]), state_db=module.Path(sys.argv[4]), registry=module.Path(sys.argv[5]), link_dir=module.Path(sys.argv[6]), audit_log=module.Path(sys.argv[7]))
print(json.dumps(module.register_controlled_thread(request, paths=paths, enabled=True, hmac_key=b"k" * 32, audit_hmac_key=b"a" * 32)))
`;
    execFileSync('/usr/bin/python3', ['-I', '-S', '-c', script, manager, JSON.stringify(request), workspace, state, registry, launcherDirectory, audit]);

    const absent = Object.assign(new Error('absent'), { status: 1, stderr: Buffer.from('no server running on /tmp/tmux-1000/default\n') });
    const authority = new ProjectHumanThreadAuthority({
      stateDatabasePath: state,
      registryPath: registry,
      launcherDirectory,
      sessionExecutable: '/home/god/.local/bin/codex-memory-session',
      tmuxExecutable: '/usr/bin/tmux',
      runTmux: () => { throw absent; },
    });
    expect(authority.inspectAdoptable(project, conversationId)).toMatchObject({ conversationId });
    const store = new ProjectHumanThreadStore(join(base, 'bindings.sqlite'));
    const service = new ProjectHumanThreadService(store, authority, { now: () => '2026-08-23T00:00:00.000Z' });
    const adopted = await service.adopt({
      projectId: 'imported-arcade', projectRoot: project, conversationId,
      provenanceDigest: 'a'.repeat(64), idempotencyKey: 'human-thread:imported-arcade:adopt',
    });
    expect(adopted).toMatchObject({ outcome: 'adopted', binding: { conversationId, purpose: 'human-interaction' } });
    expect(service.recover('imported-arcade', 1, 'human-thread:imported-arcade:recover', project))
      .toMatchObject({ outcome: 'recovered', binding: { conversationId, status: 'active' } });
    store.close();
  });
});
