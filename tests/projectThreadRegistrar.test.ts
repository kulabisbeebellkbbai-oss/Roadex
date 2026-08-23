import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  controlledBootstrapArgs,
  controlledBootstrapEnvironment,
  bootstrapControlledThread,
  createProjectThreadFinalizer,
  projectHumanThreadLocator,
  persistBootstrapReceipt,
  PROJECT_HUMAN_THREAD_SOURCE,
  readBootstrapReceipt,
  resolveControlledBootstrap,
} from '../src/server/projectThreadRegistrar';

describe('controlled project thread finalizer', () => {
  it('publishes one exact locator contract shared by bootstrap registration and recovery', () => {
    const locator = projectHumanThreadLocator({
      projectName: 'Arcade',
      projectRoot: '/tmp/Arcade',
      conversationId: '01a01569-7874-7f72-bca9-9c91bb869846',
      dev: '8',
      ino: '42',
      launcherDirectory: '/tmp/bin',
      tmuxExecutable: '/usr/bin/tmux',
      sessionExecutable: '/safe/codex-memory-session',
    });
    expect(locator).toMatchObject({
      label: 'This is the dedicated Roadex human interaction thread for the Arcade project. Do not use another thread for human interaction.',
      source: PROJECT_HUMAN_THREAD_SOURCE,
      command: 'codex-arcade-01a01569',
      launcher: '/tmp/bin/codex-arcade-01a01569',
    });
    expect(locator.content).toContain('#!/usr/bin/python3');
    expect(locator.content).toContain('fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)');
    expect(locator.content).toContain('EXPECTED_DEV = "8"');
    expect(locator.content).toContain('EXPECTED_INO = "42"');
    expect(locator.content).toContain('CONVERSATION = "01a01569-7874-7f72-bca9-9c91bb869846"');
  });

  it('requires independent literal-true bootstrap and registrar gates plus a strong key', () => {
    const base = {
      ROADEX_PROJECT_CREATION_BOOTSTRAP_ENABLED: 'true',
      ROADEX_CODEX_THREAD_REGISTRAR_ENABLED: 'true',
      ROADEX_CODEX_THREAD_REGISTRAR_HMAC_KEY: 'k'.repeat(32),
      ROADEX_CODEX_THREAD_REGISTRAR_AUDIT_HMAC_KEY: 'a'.repeat(32),
    };
    expect(createProjectThreadFinalizer(base).ready()).toBe(true);
    for (const override of [
      { ROADEX_PROJECT_CREATION_BOOTSTRAP_ENABLED: 'TRUE' },
      { ROADEX_CODEX_THREAD_REGISTRAR_ENABLED: '1' },
      { ROADEX_CODEX_THREAD_REGISTRAR_HMAC_KEY: 'short' },
      { ROADEX_CODEX_THREAD_REGISTRAR_AUDIT_HMAC_KEY: 'short' },
      { ROADEX_CODEX_THREAD_REGISTRAR_AUDIT_HMAC_KEY: 'k'.repeat(32) },
    ]) {
      expect(createProjectThreadFinalizer({ ...base, ...override }).ready()).toBe(false);
    }
  });

  it('uses the controlled profile, ignores user config and rules, and accepts no browser prompt', () => {
    const args = controlledBootstrapArgs('/tmp/approved-project');
    expect(args.slice(0, 5)).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--ignore-rules',
    ]);
    expect(args).toContain('sandbox_workspace_write.network_access=false');
    expect(args).toContain('mcp_servers.the-a-team.required=true');
    expect(args).toContain('mcp_servers.skiller.required=true');
    expect(args).toContain('/tmp/approved-project');
    expect(args.at(-1)).toContain('already-approved Roadex project thread');
    expect(args.join(' ')).not.toContain('proposal challenge');
    expect(args.join(' ')).not.toContain('lease token');
  });

  it('drops gateway, GitHub, proposal, and lease credentials from the bootstrap environment', () => {
    const environment = controlledBootstrapEnvironment({
      HOME: '/tmp/home',
      PATH: '/bin',
      GH_TOKEN: 'secret',
      GATEWAY_COOKIE: 'secret',
      PROPOSAL_CHALLENGE: 'secret',
      LEASE_TOKEN: 'secret',
    });
    expect(environment).toEqual({ HOME: '/tmp/home', PATH: '/bin' });
  });

  it('persists one exact operation-bound bootstrap receipt for restart recovery', () => {
    const directory = mkdtempSync(join(tmpdir(), 'roadex-bootstrap-receipts-'));
    const env = {
      ROADEX_PROJECT_HUMAN_THREAD_BOOTSTRAP_RECEIPT_DIR: directory,
      ROADEX_CODEX_THREAD_REGISTRAR_HMAC_KEY: 'k'.repeat(32),
    };
    const operationId = 'human-thread:arcade:create-1';
    const projectRoot = mkdtempSync(join(tmpdir(), 'roadex-bootstrap-root-Ω-'));
    const threadId = '01a01569-7874-7f72-bca9-9c91bb869846';
    persistBootstrapReceipt(operationId, projectRoot, threadId, env);
    persistBootstrapReceipt(operationId, projectRoot, threadId, env);
    expect(readBootstrapReceipt(operationId, projectRoot, env)).toBe(threadId);
    expect(() => persistBootstrapReceipt(
      operationId, projectRoot, '01a01569-7874-7f72-bca9-9c91bb869847', env,
    )).toThrow();
    const receipt = join(directory, `${createHash('sha256').update(operationId).digest('hex')}.json`);
    chmodSync(receipt, 0o644);
    expect(() => readBootstrapReceipt(operationId, projectRoot, env)).toThrow(/receipt_invalid/);

    const tamperOperationId = 'human-thread:arcade:create-2';
    persistBootstrapReceipt(tamperOperationId, projectRoot, threadId, env);
    const tamperPath = join(directory, `${createHash('sha256').update(tamperOperationId).digest('hex')}.json`);
    const tampered = JSON.parse(readFileSync(tamperPath, 'utf8')) as Record<string, unknown>;
    tampered.threadId = '01a01569-7874-7f72-bca9-9c91bb869847';
    writeFileSync(tamperPath, JSON.stringify(tampered), { mode: 0o600 });
    expect(() => readBootstrapReceipt(tamperOperationId, projectRoot, env)).toThrow(/receipt_invalid/);
  });

  it('ignores an abandoned partial receipt and publishes the complete record atomically', () => {
    const directory = mkdtempSync(join(tmpdir(), 'roadex-bootstrap-partial-'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'roadex-bootstrap-root-'));
    const env = {
      ROADEX_PROJECT_HUMAN_THREAD_BOOTSTRAP_RECEIPT_DIR: directory,
      ROADEX_CODEX_THREAD_REGISTRAR_HMAC_KEY: 'k'.repeat(32),
    };
    const operationId = 'human-thread:arcade:partial-receipt';
    const threadId = '01a01569-7874-7f72-bca9-9c91bb869846';
    writeFileSync(join(directory, `.${createHash('sha256').update(operationId).digest('hex')}.crashed.pending`), '{', { mode: 0o600 });
    persistBootstrapReceipt(operationId, projectRoot, threadId, env);
    expect(readBootstrapReceipt(operationId, projectRoot, env)).toBe(threadId);
  });

  it('publishes the external bootstrap receipt only after the child identity stream is terminal', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'roadex-bootstrap-external-'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'roadex-bootstrap-root-Ω-'));
    const executable = join(directory, 'fake-codex');
    const operationId = 'human-thread:arcade:external-receipt';
    const threadId = '01a01569-7874-7f72-bca9-9c91bb869846';
    const env = {
      PATH: '/usr/bin:/bin',
      ROADEX_PROJECT_HUMAN_THREAD_BOOTSTRAP_RECEIPT_DIR: directory,
      ROADEX_CODEX_THREAD_REGISTRAR_HMAC_KEY: 'k'.repeat(32),
    };
    writeFileSync(executable, `#!/usr/bin/python3\nimport json, time\nprint(json.dumps({"thread_id": ${JSON.stringify(threadId)}}), flush=True)\ntime.sleep(0.5)\n`, { mode: 0o755 });
    const completion = bootstrapControlledThread(projectRoot, env, operationId, executable);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readBootstrapReceipt(operationId, projectRoot, env)).toBeUndefined();
    await expect(completion).resolves.toBe(threadId);
    expect(readBootstrapReceipt(operationId, projectRoot, env)).toBe(threadId);
  });

  it('rejects a bootstrap that emits two distinct conversation identities', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'roadex-bootstrap-conflict-'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'roadex-bootstrap-root-'));
    const executable = join(directory, 'fake-codex');
    const operationId = 'human-thread:arcade:conflicting-receipt';
    const firstId = '01a01569-7874-7f72-bca9-9c91bb869846';
    const secondId = '01a01569-7874-7f72-bca9-9c91bb869847';
    const env = {
      PATH: '/usr/bin:/bin',
      ROADEX_PROJECT_HUMAN_THREAD_BOOTSTRAP_RECEIPT_DIR: directory,
      ROADEX_CODEX_THREAD_REGISTRAR_HMAC_KEY: 'k'.repeat(32),
    };
    writeFileSync(executable, `#!/usr/bin/python3\nimport json, time\nprint(json.dumps({"thread_id": ${JSON.stringify(firstId)}}), flush=True)\ntime.sleep(0.2)\nprint(json.dumps({"thread_id": ${JSON.stringify(secondId)}}), flush=True)\n`, { mode: 0o755 });
    const resolution = resolveControlledBootstrap(
      projectRoot, operationId, env,
      (root, runtimeEnv, id) => bootstrapControlledThread(root, runtimeEnv, id, executable),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readBootstrapReceipt(operationId, projectRoot, env)).toBeUndefined();
    await expect(resolution).rejects.toThrow(/bootstrap_conflicted/);
    expect(() => readBootstrapReceipt(operationId, projectRoot, env)).toThrow(/bootstrap_conflicted/);
  });

  it('kills the complete external bootstrap process group on timeout', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'roadex-bootstrap-timeout-'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'roadex-bootstrap-root-'));
    const executable = join(directory, 'fake-codex');
    const pidPath = join(directory, 'grandchild.pid');
    const env = {
      PATH: '/usr/bin:/bin',
      ROADEX_PROJECT_HUMAN_THREAD_BOOTSTRAP_RECEIPT_DIR: directory,
      ROADEX_CODEX_THREAD_REGISTRAR_HMAC_KEY: 'k'.repeat(32),
    };
    writeFileSync(executable, `#!/usr/bin/python3\nimport os, time\nopen(${JSON.stringify(pidPath)}, "w").write(str(os.getpid()))\ntime.sleep(5)\n`, { mode: 0o755 });
    await expect(bootstrapControlledThread(
      projectRoot, env, 'human-thread:arcade:timeout', executable, 2_000,
    )).rejects.toThrow(/controlled_bootstrap_failed/);
    const childPid = Number(readFileSync(pidPath, 'utf8'));
    let alive = true;
    for (let attempt = 0; attempt < 50 && alive; attempt += 1) {
      try { process.kill(childPid, 0); } catch { alive = false; }
      if (alive) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(alive).toBe(false);
  });

  it('resumes project finalization from the exact receipt without a second bootstrap', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'roadex-finalizer-receipts-'));
    const env = {
      ROADEX_PROJECT_HUMAN_THREAD_BOOTSTRAP_RECEIPT_DIR: directory,
      ROADEX_CODEX_THREAD_REGISTRAR_HMAC_KEY: 'k'.repeat(32),
    };
    const operationId = 'project-operation-finalizer-retry';
    const projectRoot = mkdtempSync(join(tmpdir(), 'roadex-finalizer-root-'));
    const threadId = '01a01569-7874-7f72-bca9-9c91bb869848';
    persistBootstrapReceipt(operationId, projectRoot, threadId, env);
    let bootstraps = 0;
    await expect(resolveControlledBootstrap(
      projectRoot, operationId, env, async () => { bootstraps += 1; return 'unexpected'; },
    )).resolves.toBe(threadId);
    expect(bootstraps).toBe(0);
  });

  it('recovers the exact externally published receipt after a later bootstrap failure', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'roadex-finalizer-failed-'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'roadex-finalizer-root-'));
    const env = {
      ROADEX_PROJECT_HUMAN_THREAD_BOOTSTRAP_RECEIPT_DIR: directory,
      ROADEX_CODEX_THREAD_REGISTRAR_HMAC_KEY: 'k'.repeat(32),
    };
    const operationId = 'project-operation-finalizer-failed-after-receipt';
    const threadId = '01a01569-7874-7f72-bca9-9c91bb869848';
    await expect(resolveControlledBootstrap(
      projectRoot, operationId, env, async () => {
        persistBootstrapReceipt(operationId, projectRoot, threadId, env);
        throw new Error('response lost after receipt');
      },
    )).resolves.toBe(threadId);
  });
});
