import { spawn } from 'node:child_process';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
} from 'node:fs';
import {
  ControlledOperationError,
  buildControlledOperationPlan,
  sanitizeControlledOperationResult,
  sanitizeControlledOperationTail,
  type ControlledCommand,
  type ControlledOperationGrant,
  type ControlledOperationPlan,
  type ControlledWorkspaceSnapshot,
} from './controlledOperations.js';

export type ControlledCommandResult = {
  exitCode: number;
  output: string;
};

export type ControlledCommandAdapter = {
  execute: (
    command: ControlledCommand,
    anchoredWorkspaceRoot: string,
    canonicalWorkspaceRoot: string,
    workspaceDescriptor: number,
  ) => Promise<ControlledCommandResult>;
};

export type ControlledOperationsExecutorOptions = {
  noNetwork?: ControlledCommandAdapter;
  npmRegistry?: ControlledCommandAdapter;
  githubSsh?: ControlledCommandAdapter;
  inspectWorkspace: (
    grant: ControlledOperationGrant,
    allowMissingLockfile: boolean,
    anchoredWorkspaceRoot?: string,
  ) => Promise<ControlledWorkspaceSnapshot>;
  auditPublication: (grant: ControlledOperationGrant) => Promise<void>;
};

export class ControlledOperationsExecutor {
  constructor(private readonly options: ControlledOperationsExecutorOptions) {}

  async execute(
    suppliedPlan: ControlledOperationPlan,
    grant: ControlledOperationGrant,
  ): Promise<{ ok: boolean; summary: string }> {
    const commitMessage = commitMessageFromPlan(suppliedPlan);
    const expected = buildControlledOperationPlan(grant, commitMessage);
    if (JSON.stringify(suppliedPlan) !== JSON.stringify(expected)) {
      throw new ControlledOperationError('plan_invalid');
    }

    const descriptor = openSync(
      grant.workspaceRoot,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    const approvedHandle = fstatSync(descriptor);
    const anchoredRoot = `/proc/${process.pid}/fd/${descriptor}`;
    try {
      const summaries: string[] = [];
      let gitSequenceStarted = false;
      for (const command of expected.commands) {
        assertWorkspaceHandle(grant.workspaceRoot, approvedHandle.dev, approvedHandle.ino);
        if (isGitMutation(command) && !gitSequenceStarted) {
          assertSnapshotMatches(
            grant,
            await this.options.inspectWorkspace(grant, grant.lockfileState === 'missing', anchoredRoot),
          );
          gitSequenceStarted = true;
        }
        if (command.network === 'github-ssh-only') {
          await this.options.auditPublication(grant);
        }
        const adapter = this.adapterFor(command.network);
        const result = await adapter.execute(command, anchoredRoot, grant.workspaceRoot, descriptor);
        const commandSummary = sanitizeControlledOperationResult(result.output).slice(-2_000);
        summaries.push(commandSummary);
        if (result.exitCode !== 0) {
          return {
            ok: false,
            summary: [
              ...summaries.slice(0, -1),
              sanitizeControlledOperationTail(result.output),
            ].join('\n').slice(-12_000),
          };
        }
        if (command.postcondition === 'package-lock-provenance') {
          const current = await this.options.inspectWorkspace(grant, false, anchoredRoot);
          assertLockfilePostcondition(grant, current);
        }
        if (isNpmCi(command)) {
          const current = await this.options.inspectWorkspace(grant, false, anchoredRoot);
          if (current.lockfileState !== 'validated') {
            throw new ControlledOperationError('lockfile_required');
          }
        }
      }
      return {
        ok: true,
        summary: summaries.join('\n').slice(0, 12_000) || 'Controlled operation completed.',
      };
    } finally {
      closeSync(descriptor);
    }
  }

  private adapterFor(network: ControlledCommand['network']): ControlledCommandAdapter {
    const adapter = network === 'denied'
      ? this.options.noNetwork
      : network === 'npm-registry-only'
        ? this.options.npmRegistry
        : this.options.githubSsh;
    if (!adapter) throw new ControlledOperationError('network_adapter_unavailable');
    return adapter;
  }
}

export function createBubblewrapNoNetworkAdapter(): ControlledCommandAdapter {
  return {
    execute(command, _anchoredWorkspaceRoot, canonicalWorkspaceRoot, workspaceDescriptor) {
      if (command.network !== 'denied') throw new ControlledOperationError('network_policy_invalid');
      return spawnBounded(
        '/usr/bin/systemd-run',
        [
          '--user', '--quiet', '--collect', '--pipe',
          '--property=MemoryMax=4G',
          '--property=TasksMax=256',
          '--property=CPUQuota=200%',
          '--property=RuntimeMaxSec=300',
          '/usr/bin/prlimit',
          '--fsize=1073741824',
          '--',
          '/usr/bin/bwrap',
          '--unshare-net',
          '--unshare-pid',
          '--die-with-parent',
          '--new-session',
          '--clearenv',
          '--setenv', 'HOME', '/nonexistent',
          '--setenv', 'LANG', 'C.UTF-8',
          '--setenv', 'LC_ALL', 'C.UTF-8',
          '--setenv', 'PATH', '/home/god/.local/node24/bin:/usr/bin:/bin',
          '--setenv', 'NODE_OPTIONS', '--max-old-space-size=3072',
          '--ro-bind', '/usr', '/usr',
          '--symlink', 'usr/bin', '/bin',
          '--symlink', 'usr/lib', '/lib',
          '--symlink', 'usr/lib64', '/lib64',
          '--dir', '/home',
          '--dir', '/home/god',
          '--dir', '/home/god/.local',
          '--dir', '/home/god/.local/bin',
          '--ro-bind', '/home/god/.local/node24', '/home/god/.local/node24',
          '--symlink', '../node24/bin/npm', '/home/god/.local/bin/npm',
          '--dir', '/home/god/Documents',
          '--dir', '/home/god/Documents/Codex Workspace',
          '--bind', '/proc/self/fd/0', canonicalWorkspaceRoot,
          '--tmpfs', '/tmp',
          '--proc', '/proc',
          '--dev', '/dev',
          '--chdir', canonicalWorkspaceRoot,
          '--',
          command.executable,
          ...command.args,
        ],
        '/',
        command.timeoutMs,
        command.maxOutputBytes,
        {},
        workspaceDescriptor,
      );
    },
  };
}

export function spawnBounded(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  extraEnv: NodeJS.ProcessEnv = {},
  stdinFd?: number,
): Promise<ControlledCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: {
        HOME: '/nonexistent',
        DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid?.()}/bus`,
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        PATH: '/home/god/.local/node24/bin:/usr/bin:/bin',
        XDG_RUNTIME_DIR: `/run/user/${process.getuid?.()}`,
        ...extraEnv,
      },
      stdio: [stdinFd ?? 'ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error, result?: ControlledCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result ?? { exitCode: 1, output: '' });
    };
    const collect = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        child.kill('SIGKILL');
        finish(new ControlledOperationError('command_output_limit'));
        return;
      }
      output += chunk.toString('utf8');
    };
    child.stdout!.on('data', collect);
    child.stderr!.on('data', collect);
    child.once('error', () => finish(new ControlledOperationError('command_failed')));
    child.once('close', (code) => finish(undefined, {
      exitCode: Number.isInteger(code) ? Number(code) : 1,
      output,
    }));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new ControlledOperationError('command_timeout'));
    }, timeoutMs);
    timer.unref();
  });
}

function commitMessageFromPlan(plan: ControlledOperationPlan): string {
  if (plan.intent === 'install-and-verify') return 'Update project';
  const command = plan.commands.find((candidate) => {
    const index = candidate.args.indexOf('commit');
    return index >= 0 && candidate.args[index + 1] === '-m';
  });
  const index = command?.args.indexOf('commit') ?? -1;
  const message = index >= 0 ? command?.args[index + 2] : undefined;
  if (
    !message
    && plan.intent === 'commit-and-push'
    && plan.commands.length === 1
    && plan.commands[0]?.network === 'github-ssh-only'
  ) return 'Update project';
  if (!message) throw new ControlledOperationError('plan_invalid');
  return message;
}

function isGitMutation(command: ControlledCommand): boolean {
  return command.executable === '/usr/bin/git' && ['config', 'add', 'commit'].some(
    (verb) => command.args.includes(verb),
  );
}

function isNpmCi(command: ControlledCommand): boolean {
  return command.executable === '/home/god/.local/bin/npm' && command.args[0] === 'ci';
}

function assertWorkspaceHandle(path: string, device: number | bigint, inode: number | bigint): void {
  const current = lstatSync(path);
  if (
    current.isSymbolicLink()
    || !current.isDirectory()
    || current.dev !== device
    || current.ino !== inode
    || realpathSync(path) !== path
  ) throw new ControlledOperationError('workspace_drift');
}

function assertSnapshotMatches(
  expected: ControlledWorkspaceSnapshot,
  current: ControlledWorkspaceSnapshot,
): void {
  for (const field of [
    'workspaceId', 'workspaceRoot', 'managedThreadId', 'repository', 'remote', 'branch',
    'headCommit', 'upstreamRef', 'upstreamCommit', 'workingTreeState', 'aheadCount',
    'behindCount', 'treeDigest', 'manifestDigest',
    'lockfileState', 'visibility',
  ] as const) {
    if (expected[field] !== current[field]) throw new ControlledOperationError('workspace_drift');
  }
}

function assertLockfilePostcondition(
  approved: ControlledWorkspaceSnapshot,
  current: ControlledWorkspaceSnapshot,
): void {
  for (const field of [
    'workspaceId', 'workspaceRoot', 'managedThreadId', 'repository', 'remote', 'branch',
    'headCommit', 'upstreamRef', 'upstreamCommit', 'workingTreeState', 'aheadCount',
    'behindCount', 'visibility',
  ] as const) {
    if (approved[field] !== current[field]) throw new ControlledOperationError('workspace_drift');
  }
  if (approved.lockfileState !== 'missing' || current.lockfileState !== 'validated') {
    throw new ControlledOperationError('lockfile_required');
  }
}
