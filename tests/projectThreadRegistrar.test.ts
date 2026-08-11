import { describe, expect, it } from 'vitest';
import {
  controlledBootstrapArgs,
  controlledBootstrapEnvironment,
  createProjectThreadFinalizer,
} from '../src/server/projectThreadRegistrar';

describe('controlled project thread finalizer', () => {
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
});
