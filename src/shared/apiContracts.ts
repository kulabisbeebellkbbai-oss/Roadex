import type {
  CancelSessionResponse,
  PromptAcceptedResponse,
  RoadexBootstrap,
  UserProfile,
} from './sessionContracts.js';

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

export function isApiError(value: unknown): value is ApiError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as ApiError).error.message === 'string'
  );
}
