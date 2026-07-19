import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { resolve } from 'node:path';

export const maxDeviceArtifactBytes = 16 * 1024 * 1024;

const storageReferencePattern = /^artifact-sha256-([a-f0-9]{64})$/;

export function deviceArtifactVaultRoot(): string {
  return resolve(process.env.ROADEX_DEVICE_ARTIFACT_VAULT ?? 'data/device-artifacts');
}

export function storageReferenceForDigest(sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid artifact digest.');
  return `artifact-sha256-${sha256}`;
}

export function storeDeviceArtifact(bytes: Buffer, expectedSha256: string): string {
  if (bytes.byteLength <= 0 || bytes.byteLength > maxDeviceArtifactBytes) {
    throw new Error('Artifact size is outside the approved boundary.');
  }
  const actualSha256 = createHash('sha256').update(bytes).digest('hex');
  if (actualSha256 !== expectedSha256) throw new Error('Artifact digest changed before vault storage.');

  const reference = storageReferenceForDigest(expectedSha256);
  const root = deviceArtifactVaultRoot();
  const target = resolveArtifactPath(root, reference);
  mkdirSync(root, { recursive: true, mode: 0o700 });

  try {
    const existing = readVaultFile(target, bytes.byteLength);
    if (existing && createHash('sha256').update(existing).digest('hex') === expectedSha256) return reference;
    if (existing) throw new Error('Artifact vault entry does not match its digest.');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }

  const temporary = resolve(root, `.artifact-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    let offset = 0;
    while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset, bytes.byteLength - offset, offset);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, target);
    return reference;
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* The atomic rename normally removes the temporary path. */ }
  }
}

export function readDeviceArtifact(
  storageReference: string,
  expectedByteLength: number,
  expectedSha256: string,
): Buffer | undefined {
  if (!storageReferencePattern.test(storageReference)) return undefined;
  if (!Number.isInteger(expectedByteLength) || expectedByteLength <= 0 || expectedByteLength > maxDeviceArtifactBytes) {
    return undefined;
  }
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) return undefined;
  try {
    const bytes = readVaultFile(resolveArtifactPath(deviceArtifactVaultRoot(), storageReference), expectedByteLength);
    if (!bytes || bytes.byteLength !== expectedByteLength) return undefined;
    return createHash('sha256').update(bytes).digest('hex') === expectedSha256 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function resolveArtifactPath(root: string, storageReference: string): string {
  if (!storageReferencePattern.test(storageReference)) throw new Error('Invalid artifact storage reference.');
  const target = resolve(root, `${storageReference}.bin`);
  if (!target.startsWith(`${resolve(root)}/`)) throw new Error('Artifact storage path escaped its vault.');
  return target;
}

function readVaultFile(path: string, maximumSize: number): Buffer | undefined {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maximumSize) return undefined;
    const bytes = readFileSync(fd);
    return bytes.byteLength === stat.size ? bytes : undefined;
  } finally {
    closeSync(fd);
  }
}
