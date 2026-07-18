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

export type PromptResponse = PromptAcceptedResponse;

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
