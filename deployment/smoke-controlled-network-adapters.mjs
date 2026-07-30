import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import {
  CONTROLLED_NPM_REGISTRY,
  sanitizeControlledOperationResult,
} from '../dist-server/src/server/controlledOperations.js';
import {
  createNpmRegistryNetworkAdapter,
} from '../dist-server/src/server/controlledOperationsNetworkAdapters.js';

const root = mkdtempSync(join(tmpdir(), 'roadex-adapter-smoke-'));
const npmExecutable = join(homedir(), '.local', 'bin', 'npm');

try {
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({
      name: 'roadex-controlled-adapter-smoke',
      version: '1.0.0',
      private: true,
      dependencies: { 'is-number': '7.0.0' },
    }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  const adapter = createNpmRegistryNetworkAdapter();
  const metadata = await adapter.execute({
    executable: npmExecutable,
    args: [
      'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund',
      '--registry', CONTROLLED_NPM_REGISTRY, '--userconfig', '/dev/null',
    ],
    network: 'npm-registry-only',
    timeoutMs: 120_000,
    maxOutputBytes: 64_000,
    postcondition: 'package-lock-provenance',
  }, root, root);
  if (metadata.exitCode !== 0) {
    process.stderr.write(`${sanitizeControlledOperationResult(metadata.output).slice(0, 2_000)}\n`);
    throw new Error('metadata smoke failed');
  }
  const install = await adapter.execute({
    executable: npmExecutable,
    args: [
      'ci', '--ignore-scripts', '--no-audit', '--no-fund',
      '--registry', CONTROLLED_NPM_REGISTRY, '--userconfig', '/dev/null',
    ],
    network: 'npm-registry-only',
    timeoutMs: 120_000,
    maxOutputBytes: 64_000,
  }, root, root);
  if (install.exitCode !== 0) {
    process.stderr.write(`${sanitizeControlledOperationResult(install.output).slice(0, 2_000)}\n`);
    throw new Error('install smoke failed');
  }
  process.stdout.write('npm_registry_adapter_smoke=passed\n');
} finally {
  rmSync(root, { recursive: true });
}
