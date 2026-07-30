import { ControlledOperationsAuditWriter } from './controlledOperationsAudit.js';
import { ControlledOperationsBroker } from './controlledOperationsBroker.js';
import {
  ControlledOperationsExecutor,
  createBubblewrapNoNetworkAdapter,
  type ControlledCommandAdapter,
} from './controlledOperationsExecutor.js';
import { startControlledOperationsListener } from './controlledOperationsListener.js';
import {
  ControlledOperationError,
  type ControlledOperationGrant,
} from './controlledOperations.js';
import { DurableControlledOperationReplayStore } from './controlledOperationReplayStore.js';
import {
  auditControlledPublication,
  inspectControlledWorkspace,
} from './controlledWorkspaceInspector.js';
import { CONTROLLED_OPERATIONS_SOCKET } from './runnerCapabilityProfile.js';
import { verifyLinuxPeerCredentials } from './controlledOperationsPeer.js';

export type ControlledOperationsHostDependencies = {
  npmRegistryAdapter?: ControlledCommandAdapter;
  githubSshAdapter?: ControlledCommandAdapter;
};

export function startControlledOperationsHost(
  env: NodeJS.ProcessEnv,
  dependencies: ControlledOperationsHostDependencies,
) {
  const config = hostConfigFromEnv(env);
  if (
    !dependencies.npmRegistryAdapter
    || !dependencies.githubSshAdapter
  ) throw new ControlledOperationError('host_configuration_invalid');
  const audit = new ControlledOperationsAuditWriter(config.auditPath, config.auditHmacKey);
  const inspect = async (
    grant: ControlledOperationGrant,
    allowMissingLockfile: boolean,
    anchoredWorkspaceRoot = grant.workspaceRoot,
  ) =>
    inspectControlledWorkspace({
      workspaceId: grant.workspaceId,
      workspaceRoot: anchoredWorkspaceRoot,
      managedThreadId: grant.managedThreadId,
      visibility: grant.visibility,
      allowMissingLockfile,
    });
  const executor = new ControlledOperationsExecutor({
    noNetwork: createBubblewrapNoNetworkAdapter(),
    npmRegistry: dependencies.npmRegistryAdapter,
    githubSsh: dependencies.githubSshAdapter,
    inspectWorkspace: inspect,
    auditPublication: async (grant) => {
      auditControlledPublication({
        workspaceRoot: grant.workspaceRoot,
        visibility: grant.visibility,
      });
    },
  });
  const broker = new ControlledOperationsBroker({
    hmacKey: config.hmacKey,
    replayStore: new DurableControlledOperationReplayStore(config.replayPath),
    resolveCurrentSnapshot: (grant) => inspect(grant, grant.lockfileState === 'missing'),
    auditPublication: async (snapshot) => {
      auditControlledPublication({
        workspaceRoot: snapshot.workspaceRoot,
        visibility: snapshot.visibility,
      });
    },
    executePlan: (plan, grant) => executor.execute(plan, grant),
    auditAccepted: async (grant) => audit.append(grant, {
      ok: true,
      operationId: grant.operationId,
      status: 'completed',
    }, 'accepted'),
    auditResult: async (grant, result) => audit.append(grant, result, 'terminal'),
  });
  return startControlledOperationsListener({
    enabled: true,
    socketPath: config.socketPath,
    verifyPeer: verifyLinuxPeerCredentials,
    execute: (request) => broker.execute(request),
  });
}

export function hostConfigFromEnv(env: NodeJS.ProcessEnv): {
  socketPath: string;
  replayPath: string;
  auditPath: string;
  hmacKey: string;
  auditHmacKey: string;
} {
  if (
    env.ROADEX_CONTROLLED_OPERATIONS_ENABLED !== 'true'
    || env.ROADEX_CONTROLLED_OPERATIONS_EXECUTOR_ENABLED !== 'true'
    || env.ROADEX_CONTROLLED_OPERATIONS_LISTENER_ENABLED !== 'true'
    || env.ROADEX_CONTROLLED_OPERATIONS_NPM_ADAPTER_ENABLED !== 'true'
    || env.ROADEX_CONTROLLED_OPERATIONS_GITHUB_SSH_ADAPTER_ENABLED !== 'true'
  ) throw new ControlledOperationError('host_disabled');
  const socketPath = env.ROADEX_CONTROLLED_OPERATION_SOCKET;
  const replayPath = env.ROADEX_CONTROLLED_OPERATIONS_REPLAY_PATH;
  const auditPath = env.ROADEX_CONTROLLED_OPERATIONS_AUDIT_PATH;
  const hmacKey = env.ROADEX_CONTROLLED_OPERATIONS_HMAC_KEY;
  const auditHmacKey = env.ROADEX_CONTROLLED_OPERATIONS_AUDIT_HMAC_KEY;
  if (
    socketPath !== CONTROLLED_OPERATIONS_SOCKET
    || !validPrivatePath(replayPath)
    || !validPrivatePath(auditPath)
    || Buffer.byteLength(hmacKey ?? '') < 32
    || Buffer.byteLength(auditHmacKey ?? '') < 32
    || hmacKey === auditHmacKey
  ) throw new ControlledOperationError('host_configuration_invalid');
  return {
    socketPath,
    replayPath,
    auditPath,
    hmacKey: hmacKey as string,
    auditHmacKey: auditHmacKey as string,
  };
}

function validPrivatePath(value: string | undefined): value is string {
  return Boolean(
    value
    && value.startsWith('/home/god/.local/share/roadex-controlled-operations/')
    && !value.includes('\0')
    && !value.includes('/../'),
  );
}
