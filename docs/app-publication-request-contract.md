# Protected Gateway app-publication requester contract

## Scope and safety boundary

Roadex can record an authenticated project owner's request for the Protected
Service Gateway to publish an application. This requester does not approve,
stage, deploy, activate, disable, or roll back a route. It has no worker and no
gateway, listener, firewall, IDS, service, credential, or authentication
mutation capability.

The Roadex endpoints are default-off and enabled only when
`ROADEX_APP_PUBLICATION_REQUEST_ENABLED` is exactly `true`. Creation also
requires protected-gateway authentication, an explicit user allowlist, a
validated project/workspace binding, and a dedicated audit HMAC key.

## Roadex requester API

### Create a request

`POST /Roadex/api/app-publication/requests`

Required headers:

- `Content-Type: application/json`
- `Idempotency-Key: <16..128 safe opaque characters>`
- normal Roadex protected-gateway authentication and CSRF headers

The server stores only a SHA-256 digest of the idempotency key. The key is
scoped to the authenticated actor and workspace.

- A new key and body returns `201` and `replayed: false`.
- An identical replay returns `200`, the original request ID, and
  `replayed: true`.
- Reusing the scoped key with a different canonical body returns `409` with
  `idempotency_conflict` and performs no mutation.
- Invalid, unauthorized, or unbound requests return a generic denial without
  disclosing another actor's records.

### Retrieve status

`GET /Roadex/api/app-publication/requests/{requestId}`

The result is owner-scoped. Missing and foreign IDs are indistinguishable.
There is intentionally no list, edit, approve, stage, deploy, activate,
rollback, or status-mutation endpoint.

## Exact immutable request body

Every object is exact: unknown fields are rejected. No free-text notes,
credentials, tokens, cookies, headers, certificates, environment values, or
authorization evidence are accepted.

```json
{
  "contractVersion": "roadex.app-publication.v1",
  "project": {
    "projectId": "donuthole",
    "projectName": "DonutHole"
  },
  "workspace": {
    "workspaceId": "donuthole"
  },
  "app": {
    "name": "DonutHole"
  },
  "publication": {
    "routePrefix": "/Roadex/DonutHole",
    "backendUrl": "http://127.0.0.1:8798",
    "allowedMethods": ["GET", "HEAD", "POST"],
    "healthPath": "/health",
    "routeSelection": "longest-prefix",
    "preserveFullPath": true,
    "pathNeeds": {
      "assets": [
        { "path": "/assets", "match": "subtree" }
      ],
      "apis": [
        { "path": "/api", "match": "subtree", "methods": ["GET", "POST"] }
      ]
    }
  },
  "rollback": {
    "mode": "disable-route",
    "healthPath": "/health"
  }
}
```

Validation requirements:

- IDs use `[A-Za-z0-9_-]` and are at most 128 characters.
- Names are trimmed safe display names, at most 80 characters.
- `routePrefix` is a normalized `/Roadex/<app>` path and cannot equal
  `/Roadex`. Double slashes, dot segments, encoded delimiters, queries,
  fragments, and ambiguous trailing slashes are rejected.
- `backendUrl` is exactly `http://127.0.0.1:<port>` with an explicit valid TCP
  port. Userinfo, query, fragment, backend paths, `localhost`, non-loopback
  hosts, and all-interface binds are rejected.
- Methods are unique members of `GET`, `HEAD`, `POST`, `PUT`, `PATCH`,
  `DELETE`, and `OPTIONS`. API path methods must be a subset of the route's
  allowed methods.
- Asset and API paths are normalized route-relative paths with exact or subtree
  matching. Duplicate path/match entries are rejected.
- `routeSelection` must be `longest-prefix` and `preserveFullPath` must be
  `true`.
- Rollback is either `disable-route`, with no previous request ID, or
  `restore-previous`, with a safe `previousRequestId`. Its health path must
  match the publication health path.

## Status response

```ts
{
  ok: true;
  request: {
    id: string;
    contractVersion: 'roadex.app-publication.v1';
    spec: AppPublicationRequestSpec;
    status: AppPublicationStatus;
    createdAt: string;
    updatedAt: string;
    gates: {
      gatewayReview: 'pending' | 'approved' | 'rejected' | 'not-required';
      idsReview: 'pending' | 'approved' | 'rejected' | 'not-required';
      activationApproval: 'pending' | 'approved' | 'rejected' | 'not-required';
    };
    gateway: {
      intakeId?: string;
      routeId?: string;
      messageCode?: string;
    };
  };
  replayed?: boolean;
}
```

Gateway references and message codes must be opaque and non-secret. Health,
listener, or route observations are evidence only; Roadex must never infer an
approval or active state from them.

## Lifecycle ownership

```text
Roadex: submitted
Gateway: intake-accepted -> review-pending
         -> changes-requested | rejected | withdrawn
         -> approved-for-staging -> staged
         -> activation-pending-approval -> active
         -> rollback-pending -> rolled-back
Gateway processing may also report failed.
```

Roadex creates only `submitted` and reads gateway-authored status. The gateway
owns every later transition. `approved-for-staging` is not activation. The
gateway may report `active` only after gateway technical review, IDS review,
and explicit activation approval are all satisfied and its own controlled
activation transaction succeeds.

The source slice implemented here persists and retrieves `submitted` only.
Later status values define the compatibility contract for the gateway intake;
they are not locally writable and no status-ingestion transport is enabled in
this change.

## Gateway-side compatible intake

The gateway side should implement:

- `POST /api/app-publication/requests` accepting the same immutable v1 spec,
  a stable Roadex request ID, authenticated requester identity, and an
  idempotency key bound to the canonical body.
- `GET /api/app-publication/requests/{requestId}` returning the constrained
  status representation above.

Its intake must not treat receipt as approval. Gateway implementation,
deployment, route configuration, listener/service activation, IDS/firewall
changes, authentication enrollment, restart, and rollback remain separate
reviewed and explicitly approved operations.
