import { describe, expect, it } from 'vitest';
import { authenticate, mockAuthToken, mockUser } from '../src/server/authService';

describe('authenticate', () => {
  it('denies missing or invalid bearer tokens', () => {
    expect(authenticate()).toMatchObject({ ok: false });
    expect(authenticate('Bearer wrong')).toMatchObject({ ok: false });
  });

  it('returns the server-owned mock user for the demo token', () => {
    expect(authenticate(`Bearer ${mockAuthToken}`)).toMatchObject({
      ok: true,
      user: mockUser,
    });
  });
});
