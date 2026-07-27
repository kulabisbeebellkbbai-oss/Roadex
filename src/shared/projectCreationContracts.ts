export type ProjectVisibility = 'public' | 'private';

export type ProjectSummary = {
  outcome: string;
  primaryUsers: string;
  majorComponents: string[];
  risks: string[];
  immediateNextSteps: string[];
};

export type ProjectCreationProposalPayload = {
  sessionId: string;
  projectName: string;
  visibility: ProjectVisibility;
  summary: ProjectSummary;
  teamId: string;
  idempotencyKey: string;
};

export type ProjectCreationConfirmPayload = {
  challenge: string;
  idempotencyKey: string;
};

export type ProjectCreationProposalPublic = {
  id: string;
  projectName: string;
  visibility: ProjectVisibility;
  status: 'pending' | 'consumed' | 'revoked' | 'expired';
  createdAt: string;
  expiresAt: string;
  operation?: {
    id: string;
    phase: ProjectCreationOperationPhase;
    createdAt: string;
  };
};

export type ProjectCreationOperationPhase =
  | 'reserved'
  | 'local-prepared'
  | 'remote-created'
  | 'pushed'
  | 'thread-started'
  | 'completed'
  | 'failed-retryable'
  | 'reconcile-required';

export type ProjectCreationChallengePublic = {
  proposalId: string;
  challenge: string;
  expiresAt: string;
};

export type ProjectCreationProposalResponse = {
  ok: true;
  proposal: ProjectCreationProposalPublic;
};

export type ProjectCreationChallengeResponse = {
  ok: true;
  challenge: ProjectCreationChallengePublic;
};
