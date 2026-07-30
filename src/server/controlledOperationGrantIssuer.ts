import type { RoadexSession, UserProfile } from '../shared/sessionContracts.js';
import {
  controlledOperationPolicyFromEnv,
  encodeSignedControlledOperationGrant,
  issueControlledOperationGrant,
} from './controlledOperations.js';
import { inspectControlledWorkspace } from './controlledWorkspaceInspector.js';

type RepositoryPolicy = {
  repository: string;
  visibility: 'private' | 'public';
};

export type ControlledOperationGrantIssueContext = {
  user: UserProfile;
  session: RoadexSession;
  prompt: string;
};

export type ControlledOperationGrantIssuer = (
  context: ControlledOperationGrantIssueContext,
) => string | undefined;

export function createControlledOperationGrantIssuer(
  env: NodeJS.ProcessEnv,
  inspect: typeof inspectControlledWorkspace = inspectControlledWorkspace,
): ControlledOperationGrantIssuer {
  const policy = controlledOperationPolicyFromEnv(env);
  const repositories = parseRepositoryPolicies(env.ROADEX_CONTROLLED_OPERATIONS_REPOSITORIES_JSON);
  const auditKey = env.ROADEX_CONTROLLED_OPERATIONS_AUDIT_HMAC_KEY;
  const configured = (
    policy.enabled
    && Buffer.byteLength(policy.hmacKey ?? '') >= 32
    && Buffer.byteLength(auditKey ?? '') >= 32
    && repositories.size > 0
  );
  return ({ user, session, prompt }) => {
    if (
      !configured
      || user.authMode !== 'protected-gateway'
      || !user.roles.includes('security-reviewer')
      || !policy.authorizedUsers.has(user.id)
      || session.userId !== user.id
      || session.lifecycle !== 'ready'
      || !session.managedThreadId
      || session.managedThreadId !== session.codexThreadId
      || !policy.authorizedWorkspaces.has(session.workspace.id)
    ) return undefined;
    const repositoryPolicy = repositories.get(session.workspace.id);
    if (!repositoryPolicy) return undefined;
    const snapshot = inspect({
      workspaceId: session.workspace.id,
      workspaceRoot: session.workspace.root,
      managedThreadId: session.managedThreadId,
      visibility: repositoryPolicy.visibility,
      allowMissingLockfile: true,
    });
    if (snapshot.repository !== repositoryPolicy.repository) return undefined;
    const grant = issueControlledOperationGrant({
      policy,
      userId: user.id,
      sessionId: session.id,
      prompt,
      snapshot,
    });
    return grant ? encodeSignedControlledOperationGrant(grant) : undefined;
  };
}

function parseRepositoryPolicies(value: string | undefined): Map<string, RepositoryPolicy> {
  if (!value || Buffer.byteLength(value) > 64_000) return new Map();
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map();
    const entries = Object.entries(parsed);
    if (!entries.length || entries.length > 64) return new Map();
    const result = new Map<string, RepositoryPolicy>();
    for (const [workspaceId, item] of entries) {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workspaceId)
        || !item
        || typeof item !== 'object'
        || Array.isArray(item)
        || Object.keys(item).sort().join(',') !== 'repository,visibility'
      ) return new Map();
      const record = item as Record<string, unknown>;
      if (
        typeof record.repository !== 'string'
        || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(record.repository)
        || (record.visibility !== 'private' && record.visibility !== 'public')
      ) return new Map();
      result.set(workspaceId, {
        repository: record.repository,
        visibility: record.visibility,
      });
    }
    return result;
  } catch {
    return new Map();
  }
}
