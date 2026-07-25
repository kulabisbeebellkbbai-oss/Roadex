import { describe, expect, it } from 'vitest';
import {
  CONTROLLED_RUNNER_PROFILE,
  resolveRunnerCapabilityProfile,
} from '../src/server/runnerCapabilityProfile';

function controlledEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ROADEX_CONTROLLED_RUNNER_ENABLED: 'true',
    ROADEX_CONTROLLED_RUNNER_AUTHORIZED_USERS: 'owner',
    ROADEX_CONTROLLED_RUNNER_WORKSPACE_IDS: 'roadex',
    ...overrides,
  };
}

describe('resolveRunnerCapabilityProfile', () => {
  it('defaults to the restricted runner when the gate is not literal true', () => {
    expect(resolveRunnerCapabilityProfile(
      { userId: 'owner', workspaceId: 'roadex' },
      { env: controlledEnv({ ROADEX_CONTROLLED_RUNNER_ENABLED: 'TRUE' }) },
    )).toEqual({ mode: 'restricted' });
  });

  it('requires both exact user and workspace allowlist entries', () => {
    const options = {
      env: controlledEnv(),
    };
    expect(resolveRunnerCapabilityProfile(
      { userId: 'other', workspaceId: 'roadex' },
      options,
    )).toEqual({ mode: 'restricted' });
    expect(resolveRunnerCapabilityProfile(
      { userId: 'owner', workspaceId: 'other' },
      options,
    )).toEqual({ mode: 'restricted' });
  });

  it('selects the fixed profile after ownership, mode, and digest validation', () => {
    expect(resolveRunnerCapabilityProfile(
      { userId: 'owner', workspaceId: 'roadex' },
      {
        env: controlledEnv(),
      },
    )).toEqual({
      mode: 'controlled-project-manager',
      profile: CONTROLLED_RUNNER_PROFILE,
    });
  });

  it('ignores malformed allowlist entries instead of broadening access', () => {
    expect(resolveRunnerCapabilityProfile(
      { userId: '../owner', workspaceId: 'roadex' },
      {
        env: controlledEnv({
          ROADEX_CONTROLLED_RUNNER_AUTHORIZED_USERS: '../owner, owner',
        }),
      },
    )).toEqual({ mode: 'restricted' });
  });
});
