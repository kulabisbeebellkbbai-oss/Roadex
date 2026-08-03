import { describe, expect, it } from 'vitest';
import { AppPublicationRequester, parseAppPublicationSpec } from '../src/server/appPublicationRequester';
import type { UserProfile } from '../src/shared/sessionContracts';

const owner: UserProfile = {
  id: 'owner',
  displayName: 'Owner',
  authMode: 'protected-gateway',
  roles: ['user'],
};

const spec = {
  contractVersion: 'roadex.app-publication.v1',
  project: { projectId: 'donuthole', projectName: 'DonutHole' },
  workspace: { workspaceId: 'donuthole' },
  app: { name: 'DonutHole' },
  publication: {
    routePrefix: '/Roadex/DonutHole',
    backendUrl: 'http://127.0.0.1:8798',
    allowedMethods: ['GET', 'HEAD', 'POST'] as const,
    healthPath: '/health',
    routeSelection: 'longest-prefix',
    preserveFullPath: true,
    pathNeeds: {
      assets: [{ path: '/assets', match: 'subtree' }],
      apis: [{ path: '/api', match: 'subtree', methods: ['GET', 'POST'] as const }],
    },
  },
  rollback: { mode: 'disable-route', healthPath: '/health' },
} as const;

function setup(databasePath = ':memory:') {
  let next = 1;
  return new AppPublicationRequester({
    workspaceBelongsToProject: (userId, projectId, workspaceId) => (
      userId === 'owner' && projectId === 'donuthole' && workspaceId === 'donuthole'
    ),
  }, {
    databasePath,
    env: {
      ROADEX_APP_PUBLICATION_REQUEST_ENABLED: 'true',
      ROADEX_APP_PUBLICATION_AUTHORIZED_USERS: 'owner',
      ROADEX_APP_PUBLICATION_AUDIT_HMAC_KEY: 'test-only-audit-key-at-least-32-bytes',
    },
    now: () => Date.parse('2026-07-31T21:30:00.000Z'),
    createId: () => `app-publication-${next++}`,
  });
}

describe('AppPublicationRequester', () => {
  it('accepts the exact contract and exposes only pending gates', () => {
    const requester = setup();
    const result = requester.create(owner, 'request-key-00000001', spec);
    expect(result).toMatchObject({
      outcome: 'created',
      request: {
        id: 'app-publication-1',
        status: 'submitted',
        gates: {
          gatewayReview: 'pending',
          idsReview: 'pending',
          activationApproval: 'pending',
        },
        gateway: {},
      },
    });
    if (result.outcome !== 'created') throw new Error('request not created');
    expect(requester.get(owner, result.request.id)).toEqual(result.request);
    expect(result.request).not.toHaveProperty('idempotencyKey');
    expect(result.request).not.toHaveProperty('activate');
  });

  it('replays an identical scoped request and conflicts on changed content', () => {
    const requester = setup();
    const first = requester.create(owner, 'request-key-00000001', spec);
    const replay = requester.create(owner, 'request-key-00000001', spec);
    const changed = requester.create(owner, 'request-key-00000001', {
      ...spec,
      app: { name: 'Changed App' },
    });
    expect(first.outcome).toBe('created');
    expect(replay).toMatchObject({ outcome: 'replayed', request: { id: 'app-publication-1' } });
    expect(changed).toEqual({ outcome: 'conflict' });
  });

  it('scopes retrieval and idempotency to the authenticated owner and workspace', () => {
    const requester = setup();
    const created = requester.create(owner, 'request-key-00000001', spec);
    if (created.outcome !== 'created') throw new Error('request not created');
    expect(requester.get({ ...owner, id: 'other' }, created.request.id)).toBeUndefined();
    expect(requester.create({ ...owner, id: 'other' }, 'request-key-00000001', spec)).toEqual({ outcome: 'denied' });
  });

  it('requires protected-gateway auth, literal enablement, allowlist, and audit key', () => {
    expect(setup().create({ ...owner, authMode: 'mock' }, 'request-key-00000001', spec).outcome).toBe('denied');
    const disabled = new AppPublicationRequester({ workspaceBelongsToProject: () => true }, {
      databasePath: ':memory:',
      env: {
        ROADEX_APP_PUBLICATION_REQUEST_ENABLED: 'TRUE',
        ROADEX_APP_PUBLICATION_AUTHORIZED_USERS: 'owner',
        ROADEX_APP_PUBLICATION_AUDIT_HMAC_KEY: 'test-only-audit-key-at-least-32-bytes',
      },
    });
    expect(disabled.create(owner, 'request-key-00000001', spec).outcome).toBe('denied');
  });

  it.each([
    ['unknown field', { ...spec, credential: 'secret' }],
    ['base Roadex prefix', { ...spec, publication: { ...spec.publication, routePrefix: '/Roadex' } }],
    ['traversal', { ...spec, publication: { ...spec.publication, routePrefix: '/Roadex/../DonutHole' } }],
    ['encoded separator', { ...spec, publication: { ...spec.publication, routePrefix: '/Roadex/Donut%2FHole' } }],
    ['remote backend', { ...spec, publication: { ...spec.publication, backendUrl: 'http://10.0.0.2:8798' } }],
    ['backend credentials', { ...spec, publication: { ...spec.publication, backendUrl: 'http://user:pass@127.0.0.1:8798' } }],
    ['backend query', { ...spec, publication: { ...spec.publication, backendUrl: 'http://127.0.0.1:8798?token=x' } }],
    ['path stripping', { ...spec, publication: { ...spec.publication, preserveFullPath: false } }],
    ['first-match routing', { ...spec, publication: { ...spec.publication, routeSelection: 'first-match' } }],
    ['duplicate methods', { ...spec, publication: { ...spec.publication, allowedMethods: ['GET', 'GET'] } }],
    ['API method outside allowlist', {
      ...spec,
      publication: {
        ...spec.publication,
        pathNeeds: { ...spec.publication.pathNeeds, apis: [{ path: '/api', match: 'subtree', methods: ['DELETE'] }] },
      },
    }],
    ['rollback health mismatch', { ...spec, rollback: { ...spec.rollback, healthPath: '/other' } }],
  ])('rejects %s', (_label, candidate) => {
    expect(parseAppPublicationSpec(candidate)).toBeUndefined();
  });

  it('requires restore metadata only for restore-previous rollback', () => {
    expect(parseAppPublicationSpec({
      ...spec,
      rollback: { mode: 'restore-previous', healthPath: '/health' },
    })).toBeUndefined();
    expect(parseAppPublicationSpec({
      ...spec,
      rollback: { mode: 'disable-route', previousRequestId: 'old', healthPath: '/health' },
    })).toBeUndefined();
    expect(parseAppPublicationSpec({
      ...spec,
      rollback: { mode: 'restore-previous', previousRequestId: 'old-request', healthPath: '/health' },
    })).toBeDefined();
  });
});
