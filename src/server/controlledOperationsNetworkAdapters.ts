import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  CONTROLLED_GITHUB_KNOWN_HOSTS,
  CONTROLLED_GITHUB_SSH_KEY,
  CONTROLLED_NPM_REGISTRY,
  ControlledOperationError,
  type ControlledCommand,
} from './controlledOperations.js';
import {
  spawnBounded,
  type ControlledCommandAdapter,
} from './controlledOperationsExecutor.js';

const NPM_HOST = 'registry.npmjs.org';
const GITHUB_HOST = 'github.com';
const PRIVATE_ROOT = '/home/god/.local/share/roadex-controlled-operations';
const MAX_RESOLVED_ADDRESSES = 32;

export type ResolveHost = (hostname: string) => Promise<string[]>;

export function createNpmRegistryNetworkAdapter(
  resolveHost: ResolveHost = resolveAddresses,
): ControlledCommandAdapter {
  return {
    async execute(command, anchoredWorkspaceRoot, canonicalWorkspaceRoot, workspaceDescriptor) {
      assertExactNpmCommand(command);
      return executeRestrictedNetworkCommand({
        command,
        anchoredWorkspaceRoot,
        canonicalWorkspaceRoot,
        workspaceDescriptor,
        hostname: NPM_HOST,
        addresses: await resolveHost(NPM_HOST),
        extraBinds: npmBinds(),
        extraEnv: { NPM_CONFIG_CACHE: '/tmp/npm-cache' },
      });
    },
  };
}

export function createGithubSshNetworkAdapter(
  resolveHost: ResolveHost = resolveAddresses,
): ControlledCommandAdapter {
  return {
    async execute(command, anchoredWorkspaceRoot, canonicalWorkspaceRoot, workspaceDescriptor) {
      assertExactGithubPush(command);
      assertPrivateCredentialFile(CONTROLLED_GITHUB_SSH_KEY, 0o077);
      assertPrivateCredentialFile(CONTROLLED_GITHUB_KNOWN_HOSTS, 0o077);
      return executeRestrictedNetworkCommand({
        command,
        anchoredWorkspaceRoot,
        canonicalWorkspaceRoot,
        workspaceDescriptor,
        hostname: GITHUB_HOST,
        addresses: await resolveHost(GITHUB_HOST),
        extraBinds: [
          '--dir', '/home/god/.local/share',
          '--dir', PRIVATE_ROOT,
          '--ro-bind', `${PRIVATE_ROOT}/ssh`, `${PRIVATE_ROOT}/ssh`,
        ],
      });
    },
  };
}

async function executeRestrictedNetworkCommand(input: {
  command: ControlledCommand;
  anchoredWorkspaceRoot: string;
  canonicalWorkspaceRoot: string;
  workspaceDescriptor: number;
  hostname: string;
  addresses: string[];
  extraBinds: string[];
  extraEnv?: NodeJS.ProcessEnv;
}) {
  const addresses = normalizeAddresses(input.addresses);
  const temporaryRoot = mkdtempSync(join(PRIVATE_ROOT, '.network-'));
  chmodSync(temporaryRoot, 0o700);
  try {
    const hostsPath = join(temporaryRoot, 'hosts');
    writeFileSync(
      hostsPath,
      `127.0.0.1 localhost\n::1 localhost\n${addresses.map((address) => `${address} ${input.hostname}`).join('\n')}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    return await spawnBounded(
      '/usr/bin/systemd-run',
      [
        '--user', '--quiet', '--collect', '--pipe',
        '--property=MemoryMax=4G',
        '--property=TasksMax=256',
        '--property=CPUQuota=200%',
        '--property=RuntimeMaxSec=300',
        '--property=IPAddressDeny=any',
        ...addresses.flatMap((address) => [`--property=IPAddressAllow=${address}`]),
        '/usr/bin/prlimit',
        '--fsize=1073741824',
        '--',
        '/usr/bin/bwrap',
        '--unshare-pid',
        '--die-with-parent',
        '--new-session',
        '--clearenv',
        '--setenv', 'HOME', '/nonexistent',
        '--setenv', 'LANG', 'C.UTF-8',
        '--setenv', 'LC_ALL', 'C.UTF-8',
        '--setenv', 'PATH', '/home/god/.local/node24/bin:/usr/bin:/bin',
        '--setenv', 'NODE_OPTIONS', '--max-old-space-size=3072',
        ...(input.command.network === 'npm-registry-only'
          ? ['--setenv', 'NPM_CONFIG_CACHE', '/tmp/npm-cache']
          : []),
        '--ro-bind', '/usr', '/usr',
        '--symlink', 'usr/bin', '/bin',
        '--symlink', 'usr/lib', '/lib',
        '--symlink', 'usr/lib64', '/lib64',
        '--dir', '/etc',
        '--ro-bind', hostsPath, '/etc/hosts',
        '--ro-bind', '/etc/nsswitch.conf', '/etc/nsswitch.conf',
        '--ro-bind', '/etc/ssl', '/etc/ssl',
        '--dir', '/home',
        '--dir', '/home/god',
        '--dir', '/home/god/.local',
        '--dir', '/home/god/.local/bin',
        '--ro-bind', '/home/god/.local/node24', '/home/god/.local/node24',
        '--symlink', '../node24/bin/npm', '/home/god/.local/bin/npm',
        ...input.extraBinds,
        '--dir', '/home/god/Documents',
        '--dir', '/home/god/Documents/Codex Workspace',
        '--bind', '/proc/self/fd/0', input.canonicalWorkspaceRoot,
        '--dir', '/nonexistent',
        '--tmpfs', '/tmp',
        '--proc', '/proc',
        '--dev', '/dev',
        '--chdir', input.canonicalWorkspaceRoot,
        '--',
        input.command.executable,
        ...input.command.args,
      ],
      '/',
      input.command.timeoutMs,
      input.command.maxOutputBytes,
      input.extraEnv,
      input.workspaceDescriptor,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function resolveAddresses(hostname: string): Promise<string[]> {
  try {
    return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
  } catch {
    throw new ControlledOperationError('network_resolution_failed');
  }
}

function normalizeAddresses(values: string[]): string[] {
  const addresses = [...new Set(values)];
  if (
    addresses.length === 0
    || addresses.length > MAX_RESOLVED_ADDRESSES
    || addresses.some((value) => !isGlobalUnicast(value))
  ) throw new ControlledOperationError('network_resolution_failed');
  return addresses;
}

function isGlobalUnicast(value: string): boolean {
  const family = isIP(value);
  if (family === 4) {
    const [first, second] = value.split('.').map(Number);
    return !(
      first === 0
      || first === 10
      || first === 127
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 0)
      || (first === 192 && second === 168)
      || (first === 198 && (second === 18 || second === 19))
      || (first === 198 && second === 51)
      || (first === 203 && second === 0)
      || first >= 224
    );
  }
  if (family === 6) {
    const normalized = value.toLowerCase();
    const groups = normalized.split(':');
    const firstGroup = Number.parseInt(groups[0] || '0', 16);
    const secondGroup = Number.parseInt(groups[1] || '0', 16);
    const thirdGroup = Number.parseInt(groups[2] || '0', 16);
    return (
      firstGroup >= 0x2000
      && firstGroup <= 0x3fff
      && !(firstGroup === 0x2001 && secondGroup <= 0x01ff)
      && !(firstGroup === 0x2001 && secondGroup === 0x0db8)
      && firstGroup !== 0x2002
      && !(firstGroup === 0x2620 && secondGroup === 0x004f && thirdGroup === 0x8000)
      && !(firstGroup === 0x3fff && secondGroup <= 0x0fff)
    );
  }
  return false;
}

function assertExactNpmCommand(command: ControlledCommand): void {
  const operation = command.args[0];
  const expected = operation === 'install'
    ? [
        'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund',
        '--registry', CONTROLLED_NPM_REGISTRY, '--userconfig', '/dev/null',
      ]
    : [
        'ci', '--ignore-scripts', '--no-audit', '--no-fund',
        '--registry', CONTROLLED_NPM_REGISTRY, '--userconfig', '/dev/null',
      ];
  if (
    command.network !== 'npm-registry-only'
    || command.executable !== '/home/god/.local/bin/npm'
    || JSON.stringify(command.args) !== JSON.stringify(expected)
  ) throw new ControlledOperationError('network_policy_invalid');
}

function assertExactGithubPush(command: ControlledCommand): void {
  if (
    command.network !== 'github-ssh-only'
    || command.executable !== '/usr/bin/git'
    || !command.args.includes('push')
    || !command.args.includes('--receive-pack=git-receive-pack')
    || !command.args.includes('origin')
    || command.args.some((argument) => /https?:|ssh:|git:\/\//i.test(argument))
    || !command.args.includes(`core.sshCommand=/usr/bin/ssh -F /dev/null -oBatchMode=yes -oIdentitiesOnly=yes -oIdentityFile=${CONTROLLED_GITHUB_SSH_KEY} -oUserKnownHostsFile=${CONTROLLED_GITHUB_KNOWN_HOSTS} -oStrictHostKeyChecking=yes`)
  ) throw new ControlledOperationError('network_policy_invalid');
}

function assertPrivateCredentialFile(path: string, forbiddenMode: number): void {
  const stat = lstatSync(path);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.uid !== process.getuid?.()
    || (stat.mode & forbiddenMode) !== 0
    || realpathSync(path) !== path
  ) throw new ControlledOperationError('credential_configuration_invalid');
}

function npmBinds(): string[] {
  return [];
}
