import { afterEach, describe, expect, it } from 'vitest';
import {
  authenticate,
  gatewayAuthRequired,
  mockAuthToken,
  mockUser,
} from '../src/server/authService';

const originalSecret = process.env.ROADEX_GATEWAY_SHARED_SECRET;

afterEach(() => {
  if (originalSecret === undefined) {
    delete process.env.ROADEX_GATEWAY_SHARED_SECRET;
  } else {
    process.env.ROADEX_GATEWAY_SHARED_SECRET = originalSecret;
  }
});

describe('authenticate', () => {
  it('denies missing or invalid bearer tokens', () => {
    expect(authenticate()).toMatchObject({ ok: false });
    expect(authenticate({ authorization: 'Bearer wrong' })).toMatchObject({ ok: false });
  });

  it('returns the server-owned mock user for the demo token', () => {
    expect(authenticate({ authorization: `Bearer ${mockAuthToken}` })).toMatchObject({
      ok: true,
      user: mockUser,
    });
  });

  it('accepts protected gateway identity when the shared secret matches', () => {
    process.env.ROADEX_GATEWAY_SHARED_SECRET = 'shared-secret';

    expect(gatewayAuthRequired()).toBe(true);
    expect(
      authenticate({
        'x-roadex-gateway-secret': 'shared-secret',
        'x-roadex-user-id': 'owner',
        'x-roadex-display-name': 'Owner',
        'x-roadex-roles': 'user,security-reviewer',
      }),
    ).toMatchObject({
      ok: true,
      user: {
        id: 'owner',
        displayName: 'Owner',
        authMode: 'protected-gateway',
        roles: ['user', 'security-reviewer'],
      },
    });
  });

  it('disables mock bearer fallback when protected gateway auth is configured', () => {
    process.env.ROADEX_GATEWAY_SHARED_SECRET = 'shared-secret';

    expect(authenticate({ authorization: `Bearer ${mockAuthToken}` })).toMatchObject({
      ok: false,
      reason: 'Protected gateway identity headers are required.',
    });
  });
});
