import {
  ControlledOperationError,
  ControlledOperationReplayStore,
  authenticateControlledOperationGrant,
  buildControlledOperationPlan,
  decodeSignedControlledOperationGrant,
  sanitizeControlledOperationResult,
  verifyControlledOperationGrant,
  type ControlledOperationPlan,
  type ControlledOperationGrant,
  type ControlledOperationReplayStoreLike,
  type ControlledWorkspaceSnapshot,
} from './controlledOperations.js';

export type ControlledBrokerRequest = {
  token: string;
  tool: 'install_and_verify_workspace' | 'publish_git_changes';
  commitMessage?: string;
};

export type ControlledBrokerResult = {
  ok: boolean;
  operationId?: string;
  status?: 'completed' | 'denied' | 'failed';
  summary?: string;
  reason?: string;
};

export type ControlledOperationsBrokerOptions = {
  hmacKey: string | undefined;
  replayStore?: ControlledOperationReplayStoreLike;
  resolveCurrentSnapshot: (grant: ControlledOperationGrant) => Promise<ControlledWorkspaceSnapshot>;
  auditPublication: (snapshot: ControlledWorkspaceSnapshot) => Promise<void>;
  executePlan: (
    plan: ControlledOperationPlan,
    grant: ControlledOperationGrant,
  ) => Promise<{ ok: boolean; summary: string }>;
  auditAccepted?: (grant: ControlledOperationGrant) => Promise<void>;
  auditResult?: (
    grant: ControlledOperationGrant,
    result: ControlledBrokerResult,
  ) => Promise<void>;
  now?: () => number;
};

export class ControlledOperationsBroker {
  private readonly replayStore: ControlledOperationReplayStoreLike;

  constructor(private readonly options: ControlledOperationsBrokerOptions) {
    this.replayStore = options.replayStore ?? new ControlledOperationReplayStore();
  }

  async execute(request: ControlledBrokerRequest): Promise<ControlledBrokerResult> {
    try {
      if (!request || !['install_and_verify_workspace', 'publish_git_changes'].includes(request.tool)) {
        throw new ControlledOperationError('tool_denied');
      }
      const signed = decodeSignedControlledOperationGrant(request.token);
      const authenticatedGrant = authenticateControlledOperationGrant({
        token: signed,
        hmacKey: this.options.hmacKey,
        now: this.options.now?.(),
      });
      const authenticated = verifyControlledOperationGrant({
        token: signed,
        hmacKey: this.options.hmacKey,
        current: await this.options.resolveCurrentSnapshot(authenticatedGrant),
        now: this.options.now?.(),
      });
      if (authenticated.intent === 'install-and-verify' && request.tool !== 'install_and_verify_workspace') {
        throw new ControlledOperationError('intent_mismatch');
      }
      if (authenticated.intent !== 'install-and-verify' && request.tool !== 'publish_git_changes') {
        throw new ControlledOperationError('intent_mismatch');
      }
      const plan = buildControlledOperationPlan(authenticated, request.commitMessage);
      if (request.tool === 'publish_git_changes') {
        await this.options.auditPublication(authenticated);
      }
      verifyControlledOperationGrant({
        token: signed,
        hmacKey: this.options.hmacKey,
        current: await this.options.resolveCurrentSnapshot(authenticated),
        now: this.options.now?.(),
      });
      if (!this.replayStore.consume(authenticated.nonce)) {
        throw new ControlledOperationError('grant_replayed');
      }
      await this.options.auditAccepted?.(authenticated);
      let response: ControlledBrokerResult;
      try {
        const result = await this.options.executePlan(plan, authenticated);
        response = {
          ok: result.ok,
          operationId: authenticated.operationId,
          status: result.ok ? 'completed' : 'failed',
          summary: sanitizeControlledOperationResult(result.summary).slice(0, 2_000),
          ...(!result.ok ? { reason: 'operation_failed' } : {}),
        };
      } catch {
        response = {
          ok: false,
          operationId: authenticated.operationId,
          status: 'failed',
          reason: 'operation_failed',
        };
      }
      try {
        await this.options.auditResult?.(authenticated, response);
      } catch {
        return {
          ok: false,
          operationId: authenticated.operationId,
          status: 'failed',
          reason: 'audit_indeterminate',
        };
      }
      return response;
    } catch (error) {
      return {
        ok: false,
        status: 'denied',
        reason: error instanceof ControlledOperationError ? error.code : 'operation_denied',
      };
    }
  }

}
