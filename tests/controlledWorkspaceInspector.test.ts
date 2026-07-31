import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ControlledOperationError } from '../src/server/controlledOperations';
import {
  auditControlledPublication,
  inspectControlledWorkspace,
} from '../src/server/controlledWorkspaceInspector';

describe('controlled workspace inspector', () => {
  it('derives repository state and changes the digest when authorized content changes', () => {
    const root = repository();
    const first = inspect(root);
    expect(first).toMatchObject({
      repository: 'owner/project',
      remote: 'git@github.com:owner/project.git',
      branch: 'main',
      visibility: 'private',
      workingTreeState: 'clean',
      aheadCount: 0,
      behindCount: 0,
    });
    writeFileSync(join(root, 'src.ts'), 'export const value = 2;\n');
    const second = inspect(root);
    expect(second.workingTreeState).toBe('dirty');
    expect(second.treeDigest).not.toBe(first.treeDigest);
    expect(second.manifestDigest).toBe(first.manifestDigest);
    git(root, ['commit', '--allow-empty', '-m', 'Change ancestry']);
    const third = inspect(root);
    expect(third.headCommit).not.toBe(second.headCommit);
    expect(third.treeDigest).not.toBe(second.treeDigest);
  });

  it('derives exact upstream ahead and behind counts', () => {
    const root = repository();
    git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    git(root, ['branch', '--set-upstream-to=origin/main', 'main']);
    expect(inspect(root)).toMatchObject({ aheadCount: 0, behindCount: 0 });
    git(root, ['commit', '--allow-empty', '-m', 'Local publication']);
    expect(inspect(root)).toMatchObject({
      workingTreeState: 'clean',
      aheadCount: 1,
      behindCount: 0,
    });
  });

  it('rejects roots above the repository and non-GitHub SSH remotes', () => {
    const root = repository();
    expect(() => inspectControlledWorkspace({
      workspaceId: 'workspace',
      workspaceRoot: join(root, 'subdirectory'),
      managedThreadId: 'thread',
      visibility: 'private',
    })).toThrow();
    git(root, ['remote', 'set-url', 'origin', 'https://github.com/owner/project']);
    expect(() => inspect(root)).toThrowError(new ControlledOperationError('remote_denied'));

    const pushRoot = repository();
    git(pushRoot, ['remote', 'set-url', '--push', 'origin', 'git@github.com:other/project.git']);
    expect(() => inspect(pushRoot)).toThrowError(new ControlledOperationError('remote_denied'));

    const configuredRoot = repository();
    git(configuredRoot, ['config', 'filter.unsafe.clean', '/tmp/execute-me']);
    expect(() => inspect(configuredRoot)).toThrowError(
      new ControlledOperationError('git_configuration_denied'),
    );

    const attributesRoot = repository();
    writeFileSync(join(attributesRoot, '.gitattributes'), '* filter=unsafe\n');
    expect(() => inspect(attributesRoot)).toThrowError(
      new ControlledOperationError('npm_configuration_denied'),
    );
  });

  it('rejects symlinked manifests, URL dependencies, sensitive paths, and secrets', () => {
    const root = repository();
    const outside = join(root, '..', 'outside-package.json');
    writeFileSync(outside, '{"name":"outside"}\n');
    symlinkSync(outside, join(root, 'linked-package.json'));
    expect(() => inspect(root)).toThrowError(new ControlledOperationError('symlink_denied'));

    const dependencyRoot = repository();
    writeFileSync(join(dependencyRoot, 'package.json'), JSON.stringify({
      name: 'project',
      dependencies: { package: 'https://example.invalid/package.tgz' },
    }));
    expect(() => inspect(dependencyRoot)).toThrowError(
      new ControlledOperationError('dependency_specifier_denied'),
    );

    const secretRoot = repository();
    writeFileSync(join(secretRoot, '.env'), 'TOKEN=value\n');
    expect(() => auditControlledPublication({
      workspaceRoot: secretRoot,
      visibility: 'private',
    })).toThrowError(new ControlledOperationError('sensitive_path_denied'));

    const tokenRoot = repository();
    writeFileSync(join(tokenRoot, 'notes.txt'), `ghp_${'a'.repeat(32)}\n`);
    expect(() => auditControlledPublication({
      workspaceRoot: tokenRoot,
      visibility: 'private',
    })).toThrowError(new ControlledOperationError('sensitive_content_denied'));
  });

  it('hashes and audits bounded deletions and renames', () => {
    const root = repository();
    const original = inspect(root);
    unlinkSync(join(root, 'src.ts'));
    expect(inspect(root).treeDigest).not.toBe(original.treeDigest);
    expect(auditControlledPublication({ workspaceRoot: root, visibility: 'private' })).toMatchObject({
      changedFiles: 1,
      bytesScanned: 0,
    });

    const renameRoot = repository();
    renameSync(join(renameRoot, 'src.ts'), join(renameRoot, 'renamed.ts'));
    expect(() => inspect(renameRoot)).not.toThrow();
    expect(auditControlledPublication({
      workspaceRoot: renameRoot,
      visibility: 'private',
    }).changedFiles).toBeGreaterThan(0);
  });

  it('rejects sensitive paths from bounded public history', () => {
    const root = repository();
    writeFileSync(join(root, '.env'), 'NOT_A_SECRET=fixture\n');
    git(root, ['add', '--all']);
    git(root, ['commit', '-m', 'Add unsafe fixture']);
    unlinkSync(join(root, '.env'));
    git(root, ['add', '--all']);
    git(root, ['commit', '-m', 'Remove unsafe fixture']);
    expect(() => auditControlledPublication({
      workspaceRoot: root,
      visibility: 'public',
    })).toThrowError(new ControlledOperationError('sensitive_path_denied'));
  });

  it('scans NUL-containing changed files and binary blobs in public history', () => {
    const changed = repository();
    writeFileSync(join(changed, 'binary.bin'), Buffer.concat([
      Buffer.from([0, 1, 2]),
      Buffer.from(`ghp_${'a'.repeat(32)}`),
    ]));
    expect(() => auditControlledPublication({
      workspaceRoot: changed,
      visibility: 'private',
    })).toThrowError(new ControlledOperationError('sensitive_content_denied'));

    const history = repository();
    writeFileSync(join(history, 'binary.bin'), Buffer.concat([
      Buffer.from([0, 1, 2]),
      Buffer.from(`github_pat_${'b'.repeat(32)}`),
    ]));
    git(history, ['add', '--all']);
    git(history, ['commit', '-m', 'Add binary fixture']);
    unlinkSync(join(history, 'binary.bin'));
    git(history, ['add', '--all']);
    git(history, ['commit', '-m', 'Remove binary fixture']);
    expect(() => auditControlledPublication({
      workspaceRoot: history,
      visibility: 'public',
    })).toThrowError(new ControlledOperationError('sensitive_content_denied'));
  });

  it('requires validated npm lockfile provenance or an explicit metadata-only state', () => {
    const missing = repository();
    unlinkSync(join(missing, 'package-lock.json'));
    expect(() => inspect(missing)).toThrowError(new ControlledOperationError('lockfile_required'));
    expect(inspectControlledWorkspace({
      workspaceId: 'workspace',
      workspaceRoot: missing,
      managedThreadId: 'thread',
      visibility: 'private',
      allowMissingLockfile: true,
    }).lockfileState).toBe('missing');

    const untrusted = repository();
    writeFileSync(join(untrusted, 'package.json'), JSON.stringify({
      name: 'project',
      version: '0.1.0',
      dependencies: { package: '1.2.3' },
    }));
    writeFileSync(join(untrusted, 'package-lock.json'), JSON.stringify({
      name: 'project',
      version: '0.1.0',
      lockfileVersion: 3,
      packages: {
        '': { name: 'project', version: '0.1.0', dependencies: { package: '1.2.3' } },
        'node_modules/package': {
          version: '1.2.3',
          resolved: 'https://example.invalid/package.tgz',
          integrity: `sha512-${Buffer.from('fixture').toString('base64')}`,
        },
      },
    }));
    expect(() => inspect(untrusted)).toThrowError(
      new ControlledOperationError('lockfile_provenance_denied'),
    );

    const credentialed = repository();
    writeFileSync(join(credentialed, 'package.json'), JSON.stringify({
      name: 'project',
      version: '0.1.0',
      dependencies: { package: '1.2.3' },
    }));
    writeFileSync(join(credentialed, 'package-lock.json'), JSON.stringify({
      name: 'project',
      version: '0.1.0',
      lockfileVersion: 3,
      packages: {
        '': { name: 'project', version: '0.1.0', dependencies: { package: '1.2.3' } },
        'node_modules/package': {
          version: '1.2.3',
          resolved: 'https://user:password@registry.npmjs.org/package/-/package-1.2.3.tgz',
          integrity: `sha512-${Buffer.from('fixture').toString('base64')}`,
        },
      },
    }));
    expect(() => inspect(credentialed)).toThrowError(
      new ControlledOperationError('lockfile_provenance_denied'),
    );

    const nestedConflict = repository();
    writeFileSync(join(nestedConflict, 'package.json'), JSON.stringify({
      name: 'project',
      version: '0.1.0',
      dependencies: { globals: '16.3.0' },
    }));
    writeFileSync(join(nestedConflict, 'package-lock.json'), JSON.stringify({
      name: 'project',
      version: '0.1.0',
      lockfileVersion: 3,
      packages: {
        '': { name: 'project', version: '0.1.0', dependencies: { globals: '16.3.0' } },
        'node_modules/transitive/node_modules/globals': registryEntry('globals', '14.0.0'),
        'node_modules/globals': registryEntry('globals', '16.3.0'),
      },
    }));
    expect(inspect(nestedConflict).lockfileState).toBe('validated');

    const configured = repository();
    mkdirSync(join(configured, 'nested'));
    writeFileSync(join(configured, 'nested', '.npmrc'), 'registry=https://example.invalid\n');
    expect(() => inspect(configured)).toThrowError(
      new ControlledOperationError('npm_configuration_denied'),
    );
  });
});

function registryEntry(name: string, version: string) {
  return {
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
    integrity: `sha512-${Buffer.from(`${name}-${version}`).toString('base64')}`,
  };
}

function inspect(root: string) {
  return inspectControlledWorkspace({
    workspaceId: 'workspace',
    workspaceRoot: root,
    managedThreadId: 'thread',
    visibility: 'private',
  });
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'roadex-controlled-workspace-'));
  mkdirSync(join(root, 'subdirectory'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['remote', 'add', 'origin', 'git@github.com:owner/project.git']);
  writeFileSync(join(root, 'package.json'), '{"name":"project","version":"0.1.0"}\n');
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({
    name: 'project',
    version: '0.1.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'project', version: '0.1.0' },
    },
  }));
  writeFileSync(join(root, 'src.ts'), 'export const value = 1;\n');
  git(root, ['add', '--all']);
  git(root, ['commit', '-m', 'Initialize']);
  return root;
}

function git(root: string, args: string[]): string {
  return execFileSync('/usr/bin/git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { HOME: '/nonexistent', LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' },
  });
}
