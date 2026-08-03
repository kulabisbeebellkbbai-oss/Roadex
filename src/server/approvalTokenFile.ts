import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const TOKEN_FILE_ERROR = 'approval_status_token_file_invalid';
const MIN_TOKEN_BYTES = 32;
const MAX_TOKEN_BYTES = 256;
const OWNER_READ_WRITE_MODE = 0o600;
const PERMISSION_BITS = 0o777;
const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]+={0,2}$/;

export function createApprovalStatusTokenReader(env: NodeJS.ProcessEnv): () => string {
  const path = env.ROADEX_OVERSEER_APPROVAL_STATUS_TOKEN_FILE;
  if (path === undefined || path.length === 0 || !isAbsolute(path)) {
    throwTokenFileError();
  }

  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (expectedUid === undefined) {
    throwTokenFileError();
  }

  return () => {
    try {
      return readValidatedToken(path, expectedUid);
    } catch {
      throwTokenFileError();
    }
  };
}

function readValidatedToken(path: string, expectedUid: number): string {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile()
      || metadata.uid !== expectedUid
      || (metadata.mode & PERMISSION_BITS) !== OWNER_READ_WRITE_MODE
      || metadata.size < MIN_TOKEN_BYTES
      || metadata.size > MAX_TOKEN_BYTES
    ) {
      throwTokenFileError();
    }

    const buffer = Buffer.alloc(MAX_TOKEN_BYTES + 1);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead !== metadata.size || bytesRead < MIN_TOKEN_BYTES || bytesRead > MAX_TOKEN_BYTES) {
      throwTokenFileError();
    }

    const token = buffer.toString('utf8', 0, bytesRead);
    if (!BEARER_TOKEN_PATTERN.test(token)) {
      throwTokenFileError();
    }
    return token;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function throwTokenFileError(): never {
  throw new Error(TOKEN_FILE_ERROR);
}
