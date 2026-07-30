# Controlled Verification and Publishing Operations

## Status

The authorization, workspace-inspection, publication-audit, durable replay,
broker, host-executor, Unix-listener, one-time token-file transport, MCP
adapter, and dedicated npm/GitHub network adapters are implemented. Deployment
is active for explicit user, workspace, and repository allowlists. No gateway
route is exposed. The approved DonutHole dependency-installation and
verification operation completed through the protected Roadex prompt route.

## Trust Boundary

General controlled-runner shell network access remains denied. A direct,
authenticated owner prompt can match one exact operation phrase:

- `install dependencies and run verification`
- `commit`
- `commit and push`
- `commit and push all changes`

Text embedded in a longer prompt, project file, issue, comment, test fixture, or
retrieved document does not mint a grant. Punctuation variants do not match.

The server-issued grant binds the authenticated user, Roadex session, workspace
ID and canonical root, managed thread, repository, SSH remote, branch, HEAD
commit, exact origin upstream ref/commit, visibility, working-tree digest,
package-manifest/lockfile digest, operation intent, expiry, and nonce. The host
broker rechecks the current snapshot before and after inspection, then consumes
the nonce through an atomic durable replay record.

## Fixed Operations

Dependency verification permits only:

- exact semver dependency specifications;
- internal workspace references that resolve to another declared package;
- the public npm registry;
- denied project/user npm configuration;
- a package-lock v2/v3 whose package URLs use only the canonical npm registry
  and whose resolved packages have SHA-512 integrity;
- a metadata-only lockfile generation phase when no lock exists, followed by a
  mandatory provenance-validation checkpoint before `npm ci`;
- lifecycle scripts, audit submission, and funding calls disabled; and
- the fixed format, typecheck, lint, test, coverage, and build script names.

Git publication permits only:

- repository-local GitHub noreply identity;
- staging the exact authorized working tree;
- one bounded commit message;
- the exact `origin` SSH remote and bound branch; and
- a mandatory private/public publication audit immediately before nonce
  consumption.

No tool accepts an executable, command, path, registry, remote, branch, token,
credential, environment variable, package list, test script, or browser URL
from the model.

## Deployment Verification

The Linux peer helper, npm/GitHub adapters, private configuration, and user
service were installed through approved Overseer plans. Stockwell's independent
review found no remaining deployment blockers after exact service-cgroup peer
pinning, transactional activation rollback, and special-use DNS rejection were
added. Full tests, lint, build, dependency audit, disposable npm adapter smoke,
service health, socket permissions, and same-UID denial checks passed.

## Deployment Boundary

The completed deployment does not authorize:

- installing DonutHole dependencies;
- creating a DonutHole commit or lockfile;
- pushing DonutHole; or
- changing Protected Service Gateway, IDS, firewall, VPN, or Tank.

Each boundary requires a subsequent explicit approval package and rollback plan.
## Host executor source slice

The host broker remains unavailable unless the operations, executor, listener,
npm adapter, and GitHub SSH adapter gates are each the literal string `true`.
It also requires distinct grant and audit HMAC keys, the fixed service-private
Unix socket, private replay/audit paths, a same-user peer verifier, and
independently supplied npm-registry-only and GitHub-SSH-only network adapters.

No-network verification commands use Bubblewrap with new network and PID
namespaces, a minimal filesystem view, and systemd CPU/memory/task/file-size
limits. The workspace is anchored through an open directory descriptor and
rechecked before the first Git mutation.
Networked commands fail closed when their dedicated adapter is absent. Each
production adapter revalidates the exact fixed command, resolves its one
permitted hostname outside the command sandbox, creates a private fixed hosts
file, and starts the command in a systemd scope with `IPAddressDeny=any` plus
only validated global-unicast destination IP addresses. Loopback, private,
link-local, multicast, documentation, and other special-use results fail
closed. Bubblewrap supplies a minimal filesystem. The npm adapter exposes no
credentials. The GitHub adapter exposes only a fixed service-private key and
strict known-hosts file.

The Unix peer helper requires both the deployment UID and a peer process in the
exact `roadex.service` cgroup. A different same-UID process is denied. The
installer stages and validates every artifact before replacement, preserves
existing keys, activates files atomically, and restores the prior files and
service states when activation or health verification fails.

The Unix listener accepts one newline-terminated JSON request, enforces an exact
schema and byte/time limits, and creates its parent directory and socket with
owner-only permissions. Grant consumption uses the durable replay store.
Operational audit records contain only separate-HMAC pseudonyms and fixed
classifications; an accepted record is fsynced before execution and a terminal
record follows success, failure, or exception. Prompts, paths, repository names,
tokens, and command output are not written.

The deployed profile completed the separately approved DonutHole dependency
installation and verification operation. Git commit and push remain separate
exact directives and approval boundaries.
