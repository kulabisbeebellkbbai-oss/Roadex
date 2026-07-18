import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadManagedCodexThreads, managedCodexWorkspaces } from '../src/server/codexProjectsRegistry';

describe('Codex Projects registry', () => {
  it('loads valid managed conversations and rejects paths outside approved roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'roadex-projects-'));
    const project = join(root, 'Project One');
    const outside = mkdtempSync(join(tmpdir(), 'roadex-outside-'));
    const escapedLink = join(root, 'Escaped Link');
    mkdirSync(project);
    symlinkSync(outside, escapedLink);
    const registry = join(root, 'codex-projects.csv');
    writeFileSync(
      registry,
      [
        'conversation_id,label,project,created_at,updated_at',
        `019f7337-df2e-75c1-b245-5e3588a6c5aa,"Useful, quoted thread","${project}",2026-07-17T00:00:00Z,2026-07-18T00:00:00Z`,
        `019f7337-df2e-75c1-b245-5e3588a6c5ab,Outside,"${outside}",2026-07-17T00:00:00Z,2026-07-18T00:00:00Z`,
        `019f7337-df2e-75c1-b245-5e3588a6c5ac,Symlink escape,"${escapedLink}",2026-07-17T00:00:00Z,2026-07-18T00:00:00Z`,
        `not-a-thread,Bad id,"${project}",2026-07-17T00:00:00Z,2026-07-18T00:00:00Z`,
      ].join('\n'),
    );

    const threads = loadManagedCodexThreads({ registryPath: registry, allowedRoots: [root] });

    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      id: '019f7337-df2e-75c1-b245-5e3588a6c5aa',
      label: 'Useful, quoted thread',
      project: { name: 'Project One', root: project },
    });
    expect(managedCodexWorkspaces({ registryPath: registry, allowedRoots: [root] })).toEqual([
      threads[0].project,
    ]);
  });
});
