import type { UserProfile } from '../shared/sessionContracts.js';

export const mockAuthToken = 'roadex-demo-token';

export const mockUser: UserProfile = {
  id: 'demo-user',
  displayName: 'Roadex Operator',
  authMode: 'mock',
  roles: ['user', 'security-reviewer'],
};

export type AuthResult =
  | {
      ok: true;
      user: UserProfile;
    }
  | {
      ok: false;
      reason: string;
    };

export function authenticate(authorization?: string): AuthResult {
  if (authorization !== `Bearer ${mockAuthToken}`) {
    return {
      ok: false,
      reason: 'A valid mock Roadex bearer token is required.',
    };
  }

  return {
    ok: true,
    user: mockUser,
  };
}
