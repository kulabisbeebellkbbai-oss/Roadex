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

export type AuthHeaders = {
  authorization?: string | string[];
  'x-roadex-gateway-secret'?: string | string[];
  'x-roadex-user-id'?: string | string[];
  'x-roadex-display-name'?: string | string[];
  'x-roadex-roles'?: string | string[];
};

export function gatewayAuthRequired(): boolean {
  return Boolean(configuredGatewaySecret());
}

export function authenticate(headers: AuthHeaders = {}): AuthResult {
  const gatewayResult = authenticateGateway(headers);
  if (gatewayResult.ok || gatewayAuthRequired()) {
    return gatewayResult;
  }

  return authenticateMock(firstHeader(headers.authorization));
}

export function authenticateMock(authorization?: string): AuthResult {
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

function authenticateGateway(headers: AuthHeaders): AuthResult {
  const gatewaySecret = configuredGatewaySecret();
  if (!gatewaySecret) {
    return {
      ok: false,
      reason: 'Protected gateway auth is not configured.',
    };
  }

  if (firstHeader(headers['x-roadex-gateway-secret']) !== gatewaySecret) {
    return {
      ok: false,
      reason: 'Protected gateway identity headers are required.',
    };
  }

  const id = firstHeader(headers['x-roadex-user-id']);
  const displayName = firstHeader(headers['x-roadex-display-name']);
  if (!id || !displayName) {
    return {
      ok: false,
      reason: 'Protected gateway identity is incomplete.',
    };
  }

  const roles = parseRoles(firstHeader(headers['x-roadex-roles']));
  return {
    ok: true,
    user: {
      id,
      displayName,
      authMode: 'protected-gateway',
      roles,
    },
  };
}

function configuredGatewaySecret(): string | undefined {
  return process.env.ROADEX_GATEWAY_SHARED_SECRET;
}

function firstHeader(value?: string | string[]): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseRoles(value?: string): UserProfile['roles'] {
  const requested = new Set((value ?? '').split(',').map((role) => role.trim()));
  const roles: UserProfile['roles'] = ['user'];
  if (requested.has('admin')) roles.push('admin');
  if (requested.has('security-reviewer')) roles.push('security-reviewer');
  return roles;
}
