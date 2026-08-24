import { describe, expect, it } from 'vitest';
import { resolveProjectWorkspace } from '../src/projectWorkspaceSelection';

const arcade = { id: 'arcade', name: 'Arcade', root: '/srv/projects/arcade' };
const psychlo = { id: 'psychlo', name: 'Psychlo', root: '/srv/projects/psychlo' };

describe('project workspace selection', () => {
  it('keeps the project conversation available when single-thread mode has no ordinary session', () => {
    expect(resolveProjectWorkspace([arcade, psychlo], '', undefined)).toEqual(arcade);
  });

  it('prefers an explicit project and otherwise the current session project', () => {
    expect(resolveProjectWorkspace([arcade, psychlo], 'psychlo', { workspace: arcade })).toEqual(psychlo);
    expect(resolveProjectWorkspace([arcade, psychlo], '', { workspace: psychlo })).toEqual(psychlo);
  });
});
