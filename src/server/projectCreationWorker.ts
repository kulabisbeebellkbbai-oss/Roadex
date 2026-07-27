import { spawn } from 'node:child_process';
import type { UserProfile } from '../shared/sessionContracts.js';
import type { ProjectCreationOperationPhase } from '../shared/projectCreationContracts.js';
import type { ProjectCreationBroker, ProjectCreationExecutionLease } from './projectCreationBroker.js';
import {
  createProjectThreadFinalizer,
  type ProjectThreadFinalizer,
} from './projectThreadRegistrar.js';

type AdapterEvent =
  | { type: 'phase'; phase: 'local-prepared' | 'remote-created' | 'pushed' }
  | { type: 'done' }
  | { type: 'failed'; classification: string; reconcileRequired: boolean };

type WorkerBroker = Pick<ProjectCreationBroker, 'claimExecution' | 'advanceExecution'>;

export type ProjectAdapterExecutor = (
  lease: ProjectCreationExecutionLease,
  onEvent: (event: AdapterEvent) => Promise<void>,
) => Promise<void>;

export class ProjectCreationWorker {
  constructor(
    private readonly broker: WorkerBroker,
    private readonly execute: ProjectAdapterExecutor = executeFixedAdapter,
    private readonly finalizer: ProjectThreadFinalizer = createProjectThreadFinalizer(),
  ) {}

  async run(user: UserProfile, proposalId: string): Promise<boolean> {
    if (!this.finalizer.ready()) return false;
    const lease = await this.broker.claimExecution(user, proposalId);
    if (!lease) return false;
    if (lease.startPhase === 'thread-started') {
      return this.broker.advanceExecution(
        user, lease.operationId, lease.leaseToken, 'completed',
      );
    }
    let terminal = false;
    let attemptedPhase: ProjectCreationOperationPhase = lease.startPhase;
    try {
      await this.execute(lease, async (event) => {
        if (event.type === 'done') {
          if (attemptedPhase !== 'pushed' || terminal) throw new Error('worker_done_before_finalization');
          attemptedPhase = 'thread-started';
          await this.finalizer.finalize(lease);
          const registered = await this.broker.advanceExecution(
            user, lease.operationId, lease.leaseToken, 'thread-started',
          );
          if (!registered) throw new Error('worker_checkpoint_denied');
          const completed = await this.broker.advanceExecution(
            user, lease.operationId, lease.leaseToken, 'completed',
          );
          if (!completed) throw new Error('worker_checkpoint_denied');
          terminal = true;
          return;
        }
        if (terminal) throw new Error('worker_event_after_terminal');
        if (event.type === 'phase') {
          attemptedPhase = event.phase;
          const advanced = await this.broker.advanceExecution(
            user, lease.operationId, lease.leaseToken, event.phase,
          );
          if (!advanced) throw new Error('worker_checkpoint_denied');
        } else {
          const advanced = await this.broker.advanceExecution(
            user,
            lease.operationId,
            lease.leaseToken,
            event.reconcileRequired ? 'reconcile-required' : 'failed-retryable',
            event.classification,
          );
          if (!advanced) throw new Error('worker_failure_checkpoint_denied');
          terminal = true;
        }
      });
      return terminal;
    } catch {
      if (!terminal) {
        await this.broker.advanceExecution(
          user,
          lease.operationId,
          lease.leaseToken,
          ['remote-created', 'thread-started', 'completed'].includes(attemptedPhase)
            ? 'reconcile-required'
            : 'failed-retryable',
          'worker_protocol_failed',
        );
      }
      return false;
    }
  }
}

async function executeFixedAdapter(
  lease: ProjectCreationExecutionLease,
  onEvent: (event: AdapterEvent) => Promise<void>,
): Promise<void> {
  const executable = '/usr/bin/node';
  const workerPath = '/home/god/Documents/Codex Workspace/AI Project Manager/dist/src/project_creation_adapter/worker.js';
  const input = JSON.stringify({
    workspaceRoot: lease.spec.workspaceRoot,
    spec: lease.spec,
    startPhase: lease.startPhase,
  });
  const child = spawn(executable, [workerPath], {
    shell: false,
    stdio: ['pipe', 'pipe', 'ignore'],
    env: adapterEnvironment(),
  });
  child.stdin.end(input);
  let buffer = '';
  let bytes = 0;
  let terminalEvent = false;
  let terminalType: 'done' | 'failed' | undefined;
  try {
    for await (const chunk of child.stdout) {
      bytes += (chunk as Buffer).byteLength;
      if (bytes > 64_000) throw new Error('worker_output_too_large');
      buffer += String(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const event = parseAdapterEvent(line);
        await onEvent(event);
        terminalEvent ||= event.type === 'done' || event.type === 'failed';
        if (event.type === 'done' || event.type === 'failed') terminalType = event.type;
      }
    }
    if (buffer) {
      const event = parseAdapterEvent(buffer);
      await onEvent(event);
      terminalEvent ||= event.type === 'done' || event.type === 'failed';
      if (event.type === 'done' || event.type === 'failed') terminalType = event.type;
    }
  } catch (error) {
    child.kill('SIGKILL');
    if (child.exitCode === null) {
      await new Promise<void>((resolve) => child.once('close', () => resolve()));
    }
    throw error;
  }
  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once('close', resolve);
  });
  if (
    !terminalEvent
    || exitCode === null
    || (terminalType === 'done' && exitCode !== 0)
    || (terminalType === 'failed' && exitCode === 0)
  ) {
    throw new Error('worker_incomplete');
  }
}

export function adapterEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const names = [
    'HOME', 'USER', 'LANG', 'LC_ALL', 'PATH', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR',
    'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'GH_TOKEN', 'GITHUB_TOKEN',
  ];
  return Object.fromEntries(names.flatMap((name) => env[name] ? [[name, env[name]]] : []));
}

function parseAdapterEvent(line: string): AdapterEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error('worker_event_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('worker_event_invalid');
  const event = parsed as Record<string, unknown>;
  if (event.type === 'done' && Object.keys(event).length === 1) return { type: 'done' };
  if (
    event.type === 'phase'
    && Object.keys(event).sort().join(',') === 'phase,type'
    && ['local-prepared', 'remote-created', 'pushed'].includes(String(event.phase))
  ) return event as AdapterEvent;
  if (
    event.type === 'failed'
    && Object.keys(event).sort().join(',') === 'classification,reconcileRequired,type'
    && typeof event.classification === 'string'
    && /^[a-z][a-z0-9_]{0,63}$/.test(event.classification)
    && typeof event.reconcileRequired === 'boolean'
  ) return event as AdapterEvent;
  throw new Error('worker_event_invalid');
}
