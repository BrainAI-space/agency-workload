# Local Infrastructure

The local foundation uses the existing `project-postgres` PostgreSQL 16 container, plus pinned
GoTrue and Mailpit containers. The web and API applications continue to run natively.

## Setup

Requirements:

- Node.js 24 or newer
- Docker with Compose
- The approved `project-postgres` container on host port `5434`

Run:

```bash
npm ci
npm run config:check
npm run local:bootstrap
npm run config:check:runtime
npm run auth:up
npm run auth:health
```

`local:bootstrap` creates `.env` only when needed, generates development-only credentials, and
creates the dedicated database, roles, and schemas. It preserves existing secrets on later runs.
It refuses a different container name, PostgreSQL major version, host port, maintenance database,
superuser, or application database.

The generated file uses mode `0600` on POSIX. On Windows, inherited ACLs are removed and access is
limited to the current user, `SYSTEM`, and local administrators.

GoTrue `v2.192.0` migrations reference PostgreSQL's conventional `postgres` role. This cluster was
initialized without it, so bootstrap creates a locked `NOLOGIN`, non-superuser compatibility role.
The bootstrap refuses to continue if that role exists with elevated attributes.

Stop the auth services without touching PostgreSQL:

```bash
npm run auth:down
```

Rotate every Agency Workload local secret after a suspected exposure:

```bash
npm run local:rotate-secrets -- --confirm-rotation
```

The explicit mode stops GoTrue and Mailpit, rotates only the four dedicated database-role passwords
and Agency Workload signing/session keys, atomically replaces `.env`, rejects the previous database
credentials and service-role token, then restarts both services. It preserves schemas and data. It
does not change the shared PostgreSQL superuser.

Use `npm run auth:logs` for the last 100 GoTrue and Mailpit log lines. Do not paste logs into issues
without checking for email addresses or login links.

## Boundaries

- GoTrue is backend infrastructure. Application browser code must call Fastify, not GoTrue.
- GoTrue, Mailpit SMTP, and the Mailpit UI bind only to `127.0.0.1` on the host.
- Both services share a project-only bridge network; GoTrue needs host egress for PostgreSQL.
- Public signup, phone, anonymous, social, SAML, Web3, and custom OAuth providers are disabled.
- Mailpit is development-only and never relays mail.
- `.env` is ignored by Git and excluded from Docker build contexts.

## Known Blocker

The shared `project-postgres` container currently publishes port `5434` on `0.0.0.0` and `[::]`.
This repository does not own or restart that container, so the exposure is not changed here. Treat
the binding as a local security blocker and restrict it to loopback when the shared container can be
reconfigured safely.

See [`auth/README.md`](auth/README.md) for authentication and production SMTP configuration names.
