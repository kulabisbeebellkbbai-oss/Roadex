import { describe, expect, it } from 'vitest';
import {
  appPublicationRequestEnabled,
  isAvailableAppPublicationRoute,
} from '../src/server/appPublicationPolicy';

describe('app publication policy', () => {
  it('is default-off and requires literal true', () => {
    expect(appPublicationRequestEnabled({})).toBe(false);
    expect(appPublicationRequestEnabled({ ROADEX_APP_PUBLICATION_REQUEST_ENABLED: 'TRUE' })).toBe(false);
    expect(appPublicationRequestEnabled({ ROADEX_APP_PUBLICATION_REQUEST_ENABLED: 'true' })).toBe(true);
  });

  it('exposes only create and owner-scoped status routes', () => {
    const env = { ROADEX_APP_PUBLICATION_REQUEST_ENABLED: 'true' };
    expect(isAvailableAppPublicationRoute('POST', '/api/app-publication/requests', env)).toBe(true);
    expect(isAvailableAppPublicationRoute('GET', '/api/app-publication/requests/request-1', env)).toBe(true);
    for (const [method, path] of [
      ['GET', '/api/app-publication/requests'],
      ['POST', '/api/app-publication/requests/'],
      ['POST', '/api/app-publication/requests/request-1'],
      ['POST', '/api/app-publication/requests/request-1/approve'],
      ['POST', '/api/app-publication/requests/request-1/activate'],
      ['POST', '/api/app-publication/requests/request-1/deploy'],
      ['GET', '/api/app-publication/requests/request%2F1'],
    ] as const) {
      expect(isAvailableAppPublicationRoute(method, path, env)).toBe(false);
    }
  });
});
