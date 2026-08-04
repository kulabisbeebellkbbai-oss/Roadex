import {
  createApprovalWorkflowRunRuntime,
  type ApprovalWorkflowRunRuntime,
} from './sessionService.js';
import type { ApprovalWorkflowHostDependencies } from './approvalWorkflowHost.js';
import type { ApprovalWorkflowGrantBroker } from './approvalWorkflowGrantBroker.js';
import { createOverseerApprovalStageTransport } from './overseerApprovalStageTransport.js';

type ApprovalWorkflowBrokerPort = Pick<ApprovalWorkflowGrantBroker, 'issue' | 'consume' | 'revokeRun'>;

export function createProductionApprovalWorkflowRuntime(
  broker: Pick<ApprovalWorkflowGrantBroker, 'issue' | 'revokeRun'>,
  options: {
    readToken: () => string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  },
): ApprovalWorkflowRunRuntime {
  return createApprovalWorkflowRunRuntime(broker, {
    stageTypedIntent: createOverseerApprovalStageTransport(options),
  });
}

export function createProductionApprovalWorkflowHostDependencies(options: {
  broker: ApprovalWorkflowBrokerPort;
  runtime: ApprovalWorkflowRunRuntime;
  registerApprovalWait: ApprovalWorkflowHostDependencies['registerApprovalWait'];
  socketPath?: string;
}): ApprovalWorkflowHostDependencies {
  if (!options.runtime.stageTypedIntent) {
    throw new Error('approval_workflow_staging_unavailable');
  }
  return {
    consumeGrant: (token) => options.broker.consume(token),
    resolveRunContext: (runId) => options.runtime.resolveRunContext(runId),
    stageTypedIntent: options.runtime.stageTypedIntent,
    registerApprovalWait: options.registerApprovalWait,
    ...(options.socketPath ? { socketPath: options.socketPath } : {}),
  };
}
