import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import {
  ControlledOperationError,
  validatePackageManifests,
  type ControlledWorkspaceSnapshot,
} from './controlledOperations.js';

const MAX_CHANGED_FILES = 2_000;
const MAX_AUDIT_FILE_BYTES = 2_000_000;
const MAX_AUDIT_TOTAL_BYTES = 20_000_000;
const MAX_MANIFESTS = 64;

type Manifest = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  workspaces?: unknown;
  overrides?: unknown;
  packageManager?: unknown;
};

type PackageLock = {
  lockfileVersion?: unknown;
  packages?: unknown;
};

export function inspectControlledWorkspace(input: {
  workspaceId: string;
  workspaceRoot: string;
  managedThreadId: string;
  visibility: 'private' | 'public';
  allowMissingLockfile?: boolean;
}): ControlledWorkspaceSnapshot {
  const root = realpathSync(input.workspaceRoot);
  const top = git(root, ['rev-parse', '--show-toplevel']).trim();
  if (realpathSync(top) !== root) throw new ControlledOperationError('workspace_root_mismatch');
  validateGitConfiguration(root);
  const branch = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
  const remote = git(root, ['remote', 'get-url', 'origin']).trim();
  const pushRemotes = git(root, ['remote', 'get-url', '--push', '--all', 'origin'])
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (pushRemotes.length !== 1 || pushRemotes[0] !== remote) {
    throw new ControlledOperationError('remote_denied');
  }
  const repository = repositoryFromRemote(remote);
  const headCommit = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  const upstreamRef = gitOptional(root, ['rev-parse', '--symbolic-full-name', '@{upstream}'])?.trim();
  if (upstreamRef && upstreamRef !== `refs/remotes/origin/${branch}`) {
    throw new ControlledOperationError('upstream_invalid');
  }
  const upstreamCommit = upstreamRef
    ? git(root, ['rev-parse', '--verify', `${upstreamRef}^{commit}`]).trim()
    : undefined;
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const changedPaths = parseStatusPaths(status);
  const manifests = collectManifests(root);
  validatePackageManifests(manifests.map(({ value }) => value));
  const lockfile = inspectPackageLock(root, manifests, input.allowMissingLockfile === true);
  return {
    workspaceId: input.workspaceId,
    workspaceRoot: root,
    managedThreadId: input.managedThreadId,
    repository,
    remote,
    branch,
    headCommit,
    upstreamRef,
    upstreamCommit,
    treeDigest: hashWorkspaceState(root, status, changedPaths, headCommit, upstreamRef, upstreamCommit),
    manifestDigest: hashManifestState(manifests, lockfile),
    lockfileState: lockfile.state,
    visibility: input.visibility,
  };
}

export function auditControlledPublication(input: {
  workspaceRoot: string;
  visibility: 'private' | 'public';
}): { changedFiles: number; bytesScanned: number } {
  const root = realpathSync(input.workspaceRoot);
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const changedPaths = parseStatusPaths(status);
  let bytesScanned = 0;
  for (const path of changedPaths) {
    rejectSensitivePath(path);
    const absolute = containedPath(root, path);
    if (!existsSync(absolute)) continue;
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new ControlledOperationError('symlink_denied');
    if (!stat.isFile()) continue;
    if (stat.size > MAX_AUDIT_FILE_BYTES) throw new ControlledOperationError('audit_file_too_large');
    bytesScanned += stat.size;
    if (bytesScanned > MAX_AUDIT_TOTAL_BYTES) throw new ControlledOperationError('audit_too_large');
    scanSensitiveContent(readContainedFile(root, path, MAX_AUDIT_FILE_BYTES));
  }
  if (input.visibility === 'public') {
    const history = git(root, ['log', '-p', '--no-ext-diff', '--no-textconv', '--all'], MAX_AUDIT_TOTAL_BYTES);
    scanSensitiveContent(Buffer.from(history));
    const historicalPaths = git(
      root,
      ['log', '--format=', '--name-only', '-z', '--all'],
      MAX_AUDIT_TOTAL_BYTES,
    );
    for (const path of historicalPaths.split('\0').filter(Boolean)) rejectSensitivePath(path);
    scanHistoricalBlobs(root, '--all');
  } else {
    const range = publicationRange(root);
    const outgoing = git(
      root,
      ['log', '-p', '--no-ext-diff', '--no-textconv', '--format=fuller', range],
      MAX_AUDIT_TOTAL_BYTES,
    );
    scanSensitiveContent(Buffer.from(outgoing));
    const outgoingPaths = git(
      root,
      ['log', '--format=', '--name-only', '-z', range],
      MAX_AUDIT_TOTAL_BYTES,
    );
    for (const path of outgoingPaths.split('\0').filter(Boolean)) rejectSensitivePath(path);
    scanHistoricalBlobs(root, range);
  }
  return { changedFiles: changedPaths.length, bytesScanned };
}

function collectManifests(root: string): Array<{ path: string; value: Manifest; raw: Buffer }> {
  const manifests: Array<{ path: string; value: Manifest; raw: Buffer }> = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
      if (
        entry.name === '.npmrc'
        || entry.name === 'npm-shrinkwrap.json'
        || entry.name === '.gitattributes'
      ) {
        throw new ControlledOperationError('npm_configuration_denied');
      }
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new ControlledOperationError('symlink_denied');
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (entry.name !== 'package.json') continue;
      const raw = readContainedFile(root, relative(root, path), MAX_AUDIT_FILE_BYTES);
      let value: Manifest;
      try {
        value = JSON.parse(raw.toString('utf8')) as Manifest;
      } catch {
        throw new ControlledOperationError('manifest_invalid');
      }
      manifests.push({ path: relative(root, path), value, raw });
      if (manifests.length > MAX_MANIFESTS) throw new ControlledOperationError('manifest_invalid');
    }
  };
  walk(root);
  return manifests.sort((left, right) => left.path.localeCompare(right.path));
}

function hashWorkspaceState(
  root: string,
  status: string,
  paths: string[],
  headCommit: string,
  upstreamRef?: string,
  upstreamCommit?: string,
): string {
  const hash = createHash('sha256');
  hash.update(headCommit);
  hash.update(upstreamRef ?? 'no-upstream');
  hash.update(upstreamCommit ?? 'no-upstream-commit');
  hash.update(status);
  hash.update(git(
    root,
    ['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD', '--'],
    MAX_AUDIT_TOTAL_BYTES,
  ));
  for (const path of paths) {
    const absolute = containedPath(root, path);
    if (!existsSync(absolute)) {
      hash.update(path);
      hash.update('deleted');
      continue;
    }
    const stat = lstatSync(absolute);
    hash.update(path);
    hash.update(String(stat.mode));
    if (stat.isSymbolicLink()) hash.update('symlink');
    else if (stat.isFile()) hash.update(readContainedFile(root, path, MAX_AUDIT_FILE_BYTES));
  }
  return hash.digest('hex');
}

function hashManifestState(
  manifests: Array<{ path: string; raw: Buffer }>,
  lockfile: { raw: Buffer; state: 'missing' | 'validated' },
): string {
  const hash = createHash('sha256');
  for (const manifest of manifests) {
    hash.update(manifest.path);
    hash.update(manifest.raw);
  }
  hash.update('package-lock.json');
  hash.update(lockfile.raw);
  return hash.digest('hex');
}

function inspectPackageLock(
  root: string,
  manifests: Array<{ path: string; value: Manifest }>,
  allowMissing: boolean,
): { raw: Buffer; state: 'missing' | 'validated' } {
  for (const denied of ['.npmrc', 'npm-shrinkwrap.json']) {
    if (existsSync(join(root, denied))) throw new ControlledOperationError('npm_configuration_denied');
  }
  const path = 'package-lock.json';
  if (!existsSync(join(root, path))) {
    if (allowMissing) return { raw: Buffer.from('missing-lockfile'), state: 'missing' };
    throw new ControlledOperationError('lockfile_required');
  }
  const raw = readContainedFile(root, path, MAX_AUDIT_FILE_BYTES);
  let lock: PackageLock;
  try {
    lock = JSON.parse(raw.toString('utf8')) as PackageLock;
  } catch {
    throw new ControlledOperationError('lockfile_invalid');
  }
  if ((lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) || !isRecord(lock.packages)) {
    throw new ControlledOperationError('lockfile_invalid');
  }
  const workspacePaths = new Set(manifests.map((manifest) => dirname(manifest.path) === '.' ? '' : dirname(manifest.path)));
  const packageEntries = new Map<string, Record<string, unknown>>();
  for (const [packagePath, rawEntry] of Object.entries(lock.packages)) {
    if (!isRecord(rawEntry)) throw new ControlledOperationError('lockfile_invalid');
    if (packagePath === '' || workspacePaths.has(packagePath)) continue;
    if (rawEntry.link === true) {
      if (typeof rawEntry.resolved !== 'string' || !workspacePaths.has(rawEntry.resolved)) {
        throw new ControlledOperationError('lockfile_invalid');
      }
      continue;
    }
    if (!packagePath.includes('node_modules/')) throw new ControlledOperationError('lockfile_invalid');
    if (
      typeof rawEntry.resolved !== 'string'
      || !isRegistryPackageUrl(rawEntry.resolved)
      || typeof rawEntry.integrity !== 'string'
      || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(rawEntry.integrity)
    ) throw new ControlledOperationError('lockfile_provenance_denied');
    packageEntries.set(packagePath, rawEntry);
  }
  const workspaceNames = new Set(
    manifests.map((manifest) => manifest.value.name).filter((name): name is string => Boolean(name)),
  );
  for (const manifest of manifests) {
    validateManifestConfiguration(manifest.value);
    const dependencies = {
      ...(manifest.value.dependencies ?? {}),
      ...(manifest.value.devDependencies ?? {}),
      ...(manifest.value.optionalDependencies ?? {}),
      ...(manifest.value.peerDependencies ?? {}),
    };
    for (const [name, version] of Object.entries(dependencies)) {
      if (workspaceNames.has(name)) continue;
      const manifestDirectory = dirname(manifest.path) === '.' ? '' : dirname(manifest.path);
      const entry = packageEntries.get(
        manifestDirectory ? `${manifestDirectory}/node_modules/${name}` : `node_modules/${name}`,
      ) ?? packageEntries.get(`node_modules/${name}`);
      if (!entry || entry.version !== version) {
        throw new ControlledOperationError('lockfile_manifest_mismatch');
      }
    }
  }
  return { raw, state: 'validated' };
}

function validateManifestConfiguration(manifest: Manifest): void {
  if (
    manifest.workspaces !== undefined
    && !(
      Array.isArray(manifest.workspaces)
      && manifest.workspaces.every((entry) => (
        typeof entry === 'string'
        && /^[A-Za-z0-9._/-]+(?:\/\*)?$/.test(entry)
        && !entry.includes('..')
      ))
    )
  ) throw new ControlledOperationError('npm_configuration_denied');
  if (
    manifest.packageManager !== undefined
    && (typeof manifest.packageManager !== 'string' || !/^npm@\d+\.\d+\.\d+$/.test(manifest.packageManager))
  ) throw new ControlledOperationError('npm_configuration_denied');
  if (manifest.overrides !== undefined) validateOverrideValue(manifest.overrides);
}

function validateOverrideValue(value: unknown): void {
  if (typeof value === 'string') {
    if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
      throw new ControlledOperationError('dependency_specifier_denied');
    }
    return;
  }
  if (!isRecord(value)) throw new ControlledOperationError('npm_configuration_denied');
  for (const nested of Object.values(value)) validateOverrideValue(nested);
}

function isRegistryPackageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:'
      && url.hostname === 'registry.npmjs.org'
      && url.port === ''
      && url.username === ''
      && url.password === ''
      && url.search === ''
      && url.hash === ''
    );
  } catch {
    return false;
  }
}

function parseStatusPaths(status: string): string[] {
  const records = status.split('\0').filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4) throw new ControlledOperationError('git_status_invalid');
    const code = record.slice(0, 2);
    const path = record.slice(3);
    if (code.includes('R') || code.includes('C')) {
      const destination = records[++index];
      if (!destination) throw new ControlledOperationError('git_status_invalid');
      paths.push(path, destination);
    } else {
      paths.push(path);
    }
  }
  const unique = [...new Set(paths)];
  if (unique.length > MAX_CHANGED_FILES) throw new ControlledOperationError('too_many_changed_files');
  return unique.sort();
}

function containedPath(root: string, path: string): string {
  if (!path || path.startsWith('/') || path.includes('\0')) throw new ControlledOperationError('path_denied');
  const normalized = join(root, path);
  const relativePath = relative(root, normalized);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) throw new ControlledOperationError('path_denied');
  return normalized;
}

function readContainedFile(root: string, path: string, maxBytes: number): Buffer {
  const absolute = containedPath(root, path);
  assertNoSymlinkComponents(root, path);
  const parent = realpathSync(dirname(absolute));
  if (parent !== root && !parent.startsWith(`${root}${sep}`)) throw new ControlledOperationError('path_denied');
  let descriptor: number | undefined;
  try {
    descriptor = openSync(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes) throw new ControlledOperationError('audit_file_too_large');
    return readFileSync(descriptor);
  } catch (error) {
    if (error instanceof ControlledOperationError) throw error;
    throw new ControlledOperationError('file_inspection_failed');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertNoSymlinkComponents(root: string, path: string): void {
  let current = root;
  for (const component of path.split('/').filter(Boolean)) {
    current = join(current, component);
    if (lstatSync(current).isSymbolicLink()) throw new ControlledOperationError('symlink_denied');
  }
}

function rejectSensitivePath(path: string): void {
  const lower = path.toLowerCase();
  const parts = lower.split('/');
  if (
    parts.some((part) => ['local-secrets', 'data', '.ssh', '.gnupg'].includes(part))
    || parts.some((part) => part.startsWith('.env') && part !== '.env.example')
    || /\.(?:sqlite3?|db|pem|key|p12|pfx|log)$/i.test(lower)
    || parts.includes('.gitattributes')
    || basename(lower) === '.roadex-project-operation'
  ) throw new ControlledOperationError('sensitive_path_denied');
}

function scanSensitiveContent(content: Buffer): void {
  const value = content.toString('utf8');
  if (
    /(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/.test(value)
    || /sk-[A-Za-z0-9_-]{20,}/.test(value)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)
    || /Bearer\s+[A-Za-z0-9._-]{16,}/i.test(value)
  ) throw new ControlledOperationError('sensitive_content_denied');
}

function scanHistoricalBlobs(root: string, revision: string): void {
  const commits = git(root, ['rev-list', revision], MAX_AUDIT_TOTAL_BYTES)
    .split(/\r?\n/)
    .filter(Boolean);
  const objectIds = new Set<string>();
  for (const commit of commits) {
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new ControlledOperationError('git_history_invalid');
    const ids = git(
      root,
      ['ls-tree', '-r', '--full-tree', '--format=%(objectname)', commit],
      MAX_AUDIT_TOTAL_BYTES,
    ).split(/\r?\n/).filter(Boolean);
    for (const id of ids) {
      if (!/^[a-f0-9]{40,64}$/.test(id)) throw new ControlledOperationError('git_history_invalid');
      objectIds.add(id);
      if (objectIds.size > MAX_CHANGED_FILES) throw new ControlledOperationError('audit_too_large');
    }
  }
  let total = 0;
  for (const id of objectIds) {
    const size = Number(git(root, ['cat-file', '-s', id]).trim());
    if (!Number.isSafeInteger(size) || size < 0) throw new ControlledOperationError('git_history_invalid');
    if (size > MAX_AUDIT_FILE_BYTES) throw new ControlledOperationError('audit_file_too_large');
    total += size;
    if (total > MAX_AUDIT_TOTAL_BYTES) throw new ControlledOperationError('audit_too_large');
    scanSensitiveContent(gitBuffer(root, ['cat-file', 'blob', id], MAX_AUDIT_FILE_BYTES));
  }
}

function validateGitConfiguration(root: string): void {
  const denied = gitOptional(root, [
    'config',
    '--local',
    '--includes',
    '--name-only',
    '--get-regexp',
    '^(filter\\.|url\\.|remote\\.origin\\.(receivepack|uploadpack)$|core\\.(sshcommand|attributesfile)$|include\\.|includeif\\.)',
  ]);
  if (denied?.trim()) throw new ControlledOperationError('git_configuration_denied');
  if (existsSync(join(root, '.git', 'info', 'attributes'))) {
    throw new ControlledOperationError('git_configuration_denied');
  }
}

function repositoryFromRemote(remote: string): string {
  const match = remote.match(/^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\.git$/);
  if (!match) throw new ControlledOperationError('remote_denied');
  return match[1];
}

function git(root: string, args: string[], maxBuffer = 2_000_000): string {
  try {
    return gitBuffer(root, args, maxBuffer).toString('utf8');
  } catch {
    throw new ControlledOperationError('git_inspection_failed');
  }
}

function gitBuffer(root: string, args: string[], maxBuffer = 2_000_000): Buffer {
  try {
    return execFileSync('/usr/bin/git', gitInspectionArgs(args), {
      cwd: root,
      env: {
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        HOME: '/nonexistent',
        LANG: 'C.UTF-8',
        PATH: '/usr/bin:/bin',
      },
      maxBuffer,
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new ControlledOperationError('git_inspection_failed');
  }
}

function gitInspectionArgs(args: string[]): string[] {
  return [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    '-c', 'credential.helper=',
    '-c', 'core.sshCommand=/usr/bin/false',
    ...args,
  ];
}

function gitOptional(root: string, args: string[]): string | undefined {
  try {
    return git(root, args);
  } catch {
    return undefined;
  }
}

function publicationRange(root: string): string {
  const upstream = gitOptional(root, ['rev-parse', '--symbolic-full-name', '@{upstream}'])?.trim();
  return upstream ? `${upstream}..HEAD` : 'HEAD';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
