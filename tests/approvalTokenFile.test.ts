import { constants } from 'node:fs';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApprovalStatusTokenReader } from '../src/server/approvalTokenFile';

const TOKEN = 'roadex_approval_status_token_1234567890';
const ERROR_CODE = 'approval_status_token_file_invalid';
const createdDirectories: string[] = [];

async function createTestDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'roadex-token-'));
  await chmod(directory, 0o700);
  createdDirectories.push(directory);
  return directory;
}

async function createTokenFile(token = TOKEN, mode = 0o600): Promise<string> {
  const directory = await createTestDirectory();
  const path = join(directory, 'approval-status.token');
  await writeFile(path, token, { encoding: 'utf8', mode });
  await chmod(path, mode);
  return path;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of createdDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('approval status token file', () => {
  it('reopens a bounded owner-only regular file so rotation and deletion are observed', async () => {
    const path = await createTokenFile();
    const readToken = createApprovalStatusTokenReader({
      ROADEX_OVERSEER_APPROVAL_STATUS_TOKEN_FILE: path,
    });

    expect(readToken()).toBe(TOKEN);
    const replacement = 'replacement_approval_status_token_123456';
    await writeFile(path, replacement, { mode: 0o600 });
    expect(readToken()).toBe(replacement);
    await rm(path);
    expect(readToken).toThrow(ERROR_CODE);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['relative', 'secrets/approval-status.token'],
  ])('rejects a %s configured path', (_label, path) => {
    expect(() => createApprovalStatusTokenReader({
      ROADEX_OVERSEER_APPROVAL_STATUS_TOKEN_FILE: path,
    })).toThrow(ERROR_CODE);
  });

  it('rejects a symbolic link without following it', async () => {
    const target = await createTokenFile();
    const linkDirectory = await createTestDirectory();
    const link = join(linkDirectory, 'approval-status.token');
    await symlink(target, link);

    expect(() => createApprovalStatusTokenReader({
      ROADEX_OVERSEER_APPROVAL_STATUS_TOKEN_FILE: link,
    })()).toThrow(ERROR_CODE);
    expect(constants.O_NOFOLLOW).toBeGreaterThan(0);
  });

  it('rejects a non-regular file', async () => {
    const directory = await createTestDirectory();

    expect(() => createApprovalStatusTokenReader({
      ROADEX_OVERSEER_APPROVAL_STATUS_TOKEN_FILE: directory,
    })()).toThrow(ERROR_CODE);
  });

  it('rejects a token file owned by a different uid', async () => {
    const path = await createTokenFile();
    const currentUid = process.getuid();
    vi.spyOn(process, 'getuid').mockReturnValue(currentUid + 1);

    expect(() => createApprovalStatusTokenReader({
      ROADEX_OVERSEER_APPROVAL_STATUS_TOKEN_FILE: path,
    })()).toThrow(ERROR_CODE);
  });

  it.each([0o640, 0o604, 0o400, 0o700])('rejects non-0600 permissions %s', async (mode) => {
    const path = await createTokenFile(TOKEN, mode);

    expect(() => createApprovalStatusTokenReader({
      ROADEX_OVERSEER_APPROVAL_STATUS_TOKEN_FILE: path,
    })()).toThrow(ERROR_CODE);
  });

  it.each([
    ['undersized', 'a'.repeat(31)],
    ['oversized', 'a'.repeat(257)],
    ['whitespace', `${'a'.repeat(31)}\n`],
    ['invalid character', `${'a'.repeat(31)}:`],
    ['misplaced padding', `${'a'.repeat(31)}=a`],
  ])('rejects %s token content', async (_label, token) => {
    const path = await createTokenFile(token);

    expect(() => createApprovalStatusTokenReader({
      ROADEX_OVERSEER_APPROVAL_STATUS_TOKEN_FILE: path,
    })()).toThrow(ERROR_CODE);
  });

  it('does not expose the configured path or token in errors', async () => {
    const secretPathSegment = `secret-path-${crypto.randomUUID()}`;
    const directory = await createTestDirectory();
    const path = join(directory, secretPathSegment);
    const secretToken = `secret_token_${'x'.repeat(260)}`;
    await writeFile(path, secretToken, { mode: 0o600 });

    let failure: unknown;
    try {
      createApprovalStatusTokenReader({ ROADEX_OVERSEER_APPROVAL_STATUS_TOKEN_FILE: path })();
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(ERROR_CODE);
    expect(JSON.stringify(failure)).not.toContain(secretPathSegment);
    expect(JSON.stringify(failure)).not.toContain(secretToken);
  });
});
