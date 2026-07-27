import { describe, expect, it } from 'vitest';
import {
  isAvailableProjectCreationRoute,
  projectCreationConfirmEnabled,
  projectCreationExecutionEnabled,
  projectCreationRequestEnabled,
} from '../src/server/projectCreationPolicy';

describe('project creation policy', () => {
  it('requires literal true for each independent gate', () => {
    const malformed = {
      ROADEX_PROJECT_CREATION_REQUEST_ENABLED: 'TRUE',
      ROADEX_PROJECT_CREATION_CONFIRM_ENABLED: '1',
      ROADEX_PROJECT_CREATION_EXECUTION_ENABLED: 'yes',
    };
    expect(projectCreationRequestEnabled(malformed)).toBe(false);
    expect(projectCreationConfirmEnabled(malformed)).toBe(false);
    expect(projectCreationExecutionEnabled(malformed)).toBe(false);
    expect(projectCreationRequestEnabled({ ROADEX_PROJECT_CREATION_REQUEST_ENABLED: 'true' })).toBe(true);
    expect(projectCreationConfirmEnabled({ ROADEX_PROJECT_CREATION_CONFIRM_ENABLED: 'true' })).toBe(true);
    expect(projectCreationExecutionEnabled({ ROADEX_PROJECT_CREATION_EXECUTION_ENABLED: 'true' })).toBe(true);
  });

  it('exposes only exact request and status routes under the request gate', () => {
    const env = { ROADEX_PROJECT_CREATION_REQUEST_ENABLED: 'true' };
    expect(isAvailableProjectCreationRoute('POST', '/api/project-creation/proposals', env)).toBe(true);
    expect(isAvailableProjectCreationRoute('GET', '/api/project-creation/proposals/proposal-1', env)).toBe(true);
    expect(isAvailableProjectCreationRoute('POST', '/api/project-creation/proposals/proposal-1/revoke', env)).toBe(true);
    for (const [method, path] of [
      ['GET', '/api/project-creation/proposals'],
      ['POST', '/api/project-creation/proposals/'],
      ['POST', '/api/project-creation/proposals/proposal-1'],
      ['POST', '/api/project-creation/proposals/proposal%2F1/revoke'],
      ['POST', '/api/project-creation/proposals/proposal-1/execute'],
      ['POST', '/api/project-creation/operations'],
    ] as const) {
      expect(isAvailableProjectCreationRoute(method, path, env)).toBe(false);
    }
  });

  it('requires the separate confirmation gate for challenge and confirm', () => {
    const env = { ROADEX_PROJECT_CREATION_CONFIRM_ENABLED: 'true' };
    expect(isAvailableProjectCreationRoute(
      'POST',
      '/api/project-creation/proposals/proposal-1/challenge',
      env,
    )).toBe(true);
    expect(isAvailableProjectCreationRoute(
      'POST',
      '/api/project-creation/proposals/proposal-1/confirm',
      env,
    )).toBe(true);
    expect(isAvailableProjectCreationRoute(
      'POST',
      '/api/project-creation/proposals/proposal-1/revoke',
      env,
    )).toBe(false);
  });
});
