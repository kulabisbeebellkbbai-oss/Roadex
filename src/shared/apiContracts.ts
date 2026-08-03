import type {
  CancelSessionResponse,
  CloseSessionResponse,
  PromptAcceptedResponse,
  ReopenSessionResponse,
  RoadexBootstrap,
  RoadexSession,
  UserProfile,
} from './sessionContracts.js';
import type {
  DeviceBridgeRequestPayload as BridgeRequestPayload,
  DeviceBridgeRequestResponse as BridgeRequestResponse,
} from './deviceBridgeContracts.js';

export type ApiError = {
  error: {
    code: string;
    message: string;
    gate?: string;
  };
};

export type MockLoginResponse = {
  user: UserProfile;
  token: string;
};

export type BootstrapResponse = RoadexBootstrap;

export type PromptRequest = {
  prompt: string;
};

export type PromptApprovalPendingResponse = {
  accepted: false;
  error: {
    code: 'human-approval-pending';
    message: string;
  };
};

export type PromptResponse = PromptAcceptedResponse | PromptApprovalPendingResponse;

export type CancelResponse = CancelSessionResponse;

export type CloseResponse = CloseSessionResponse;

export type ReopenResponse = ReopenSessionResponse;

export type DeviceBridgeRequestIntakePayload = BridgeRequestPayload;

export type DeviceBridgeRequestIntakeResponse = BridgeRequestResponse;

export type ArchivedSessionsResponse = {
  sessions: RoadexSession[];
};

export function isApiError(value: unknown): value is ApiError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as ApiError).error.message === 'string'
  );
}

export function isPromptApprovalPendingResponse(value: unknown): value is PromptApprovalPendingResponse {
  if (!hasExactKeys(value, ['accepted', 'error']) || value.accepted !== false) return false;
  if (!hasExactKeys(value.error, ['code', 'message'])) return false;
  return value.error.code === 'human-approval-pending'
    && typeof value.error.message === 'string'
    && value.error.message.length > 0;
}

function hasExactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
