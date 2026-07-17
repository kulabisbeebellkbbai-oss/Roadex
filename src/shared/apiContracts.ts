import type { AuditEvent, RoadexBootstrap, StreamEvent, UserProfile } from './sessionContracts.js';

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

export type PromptResponse = {
  accepted: true;
  events: StreamEvent[];
  auditEvent: AuditEvent;
};

export function isApiError(value: unknown): value is ApiError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as ApiError).error.message === 'string'
  );
}
