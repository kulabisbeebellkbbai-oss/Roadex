export const APP_PUBLICATION_CONTRACT_VERSION = 'roadex.app-publication.v1' as const;

export type AppPublicationHttpMethod =
  | 'GET'
  | 'HEAD'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'OPTIONS';

export type AppPublicationPathNeed = {
  path: string;
  match: 'exact' | 'subtree';
};

export type AppPublicationApiPathNeed = AppPublicationPathNeed & {
  methods: AppPublicationHttpMethod[];
};

export type AppPublicationRequestSpec = {
  contractVersion: typeof APP_PUBLICATION_CONTRACT_VERSION;
  project: {
    projectId: string;
    projectName: string;
  };
  workspace: {
    workspaceId: string;
  };
  app: {
    name: string;
  };
  publication: {
    routePrefix: string;
    backendUrl: string;
    allowedMethods: AppPublicationHttpMethod[];
    healthPath: string;
    routeSelection: 'longest-prefix';
    preserveFullPath: true;
    pathNeeds: {
      assets: AppPublicationPathNeed[];
      apis: AppPublicationApiPathNeed[];
    };
  };
  rollback: {
    mode: 'disable-route' | 'restore-previous';
    previousRequestId?: string;
    healthPath: string;
  };
};

export type AppPublicationStatus =
  | 'submitted'
  | 'intake-accepted'
  | 'review-pending'
  | 'changes-requested'
  | 'rejected'
  | 'withdrawn'
  | 'approved-for-staging'
  | 'staged'
  | 'activation-pending-approval'
  | 'active'
  | 'rollback-pending'
  | 'rolled-back'
  | 'failed';

export type AppPublicationGateStatus = 'pending' | 'approved' | 'rejected' | 'not-required';

export type AppPublicationRequestPublic = {
  id: string;
  contractVersion: typeof APP_PUBLICATION_CONTRACT_VERSION;
  spec: AppPublicationRequestSpec;
  status: AppPublicationStatus;
  createdAt: string;
  updatedAt: string;
  gates: {
    gatewayReview: AppPublicationGateStatus;
    idsReview: AppPublicationGateStatus;
    activationApproval: AppPublicationGateStatus;
  };
  gateway: {
    intakeId?: string;
    routeId?: string;
    messageCode?: string;
  };
};

export type AppPublicationRequestResponse = {
  ok: true;
  request: AppPublicationRequestPublic;
  replayed?: boolean;
};
