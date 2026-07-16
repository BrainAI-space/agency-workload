# Local Database, Auth, And Email

Agency Workload uses a dedicated PostgreSQL database and self-hosted GoTrue for email ownership.
Mailpit captures local email. Supabase CLI, Studio, PostgREST, Realtime, Redis, and an ORM are not
part of this foundation.

This is the optional canonical persistent development layout. `.env.example` documents its shared
container names, ports, and origins. A clean public clone uses `npm run verify`; disposable PostgreSQL,
auth, and browser commands generate their own configuration and do not require this setup or `.env`.

## Start The Persistent Stack

With the approved PostgreSQL 16 container already running on host port `5434`:

```bash
npm ci
npm run config:check
npm run local:bootstrap
npm run config:check:runtime
npm run auth:up
npm run db:migrate
npm run auth:bootstrap-owner
npm run auth:health
```

The bootstrap command creates an ignored `.env`, generates development-only values without printing
them, and prepares `agency_workload`. Running it again keeps existing secrets and data. It never
drops a database or schema.

`npm run test:bootstrap:integration` verifies this persistent role/bootstrap path only from the exact
private canonical Git origin. Public and unknown origins fail before `.env`, Docker, or database I/O.
It is not a public clean-clone gate.

Bootstrap applies mode `0600` on POSIX. On Windows it removes inherited ACLs and grants access only
to the current user, `SYSTEM`, and local administrators.

The database roles are separated by purpose:

| Role | Login | Scope |
|---|---:|---|
| `agency_workload_owner` | No | Owns the database and `app` schema |
| `agency_workload_migrator` | Yes | Creates application objects in `app` |
| `agency_workload_runtime` | Yes | Application data access in `app` |
| `supabase_auth_admin` | Yes | Owns and migrates `auth` |
| `agency_workload_backup` | Yes | Read-only backup access |

`PUBLIC` has no access to the application database or its schemas. GoTrue cannot use `app`, and the
application runtime cannot use `auth`.

Bootstrap reapplies broad grants to existing application tables so normal runtime and backup access
stays repairable. Immediately afterward, when `app.schema_migrations` exists, it revokes every table
privilege from `agency_workload_runtime` and `agency_workload_backup`. It also reapplies the
`audit_events` runtime `UPDATE`/`DELETE` denial. The checks are conditional, so the same bootstrap SQL
works before the first migration and on later reruns.

## Migration And Rollback Integrity

`schema_migrations.checksum` remains the original binding of each migration ID to its exact up SQL.
Migration `0009_down_migration_checksums` adds a separate nullable `down_checksum` field without
changing the stored up checksums for already-applied migrations `0001` through `0008`. During a
normal `npm run db:migrate`, the runner fills missing down checksums from the reviewed in-process
migration registry. New migrations record both checksums. A non-null down checksum is never updated
by the runner. Forward validation rejects any non-null down checksum that differs from the local
registry before applying or backfilling anything; only a null legacy value is eligible for one-time
trust-on-first-use backfill.

Both migration directions require the applied IDs, sorted ascending, to be an exact prefix of the
provided local registry. Empty and current known prefixes are valid. A newer database, unknown ID,
gap, duplicate, or non-prefix order fails before migration, backfill, or down SQL with:

```text
Applied migration history is not an exact local prefix
```

Every rollback validates both the existing up checksum and the separate down checksum before any
down SQL starts. A database last migrated by a pre-`0009` runner must run `npm run db:migrate` before
its first rollback. The stable refusal is:

```text
Down migration checksum missing: <migration-id>. Run migrateUp before rollback.
```

Changed down SQL fails with `Down migration checksum mismatch: <migration-id>`. Migration `0009`
deliberately retains the metadata field when its own marker is rolled back so checksums remain
available while older migrations are rolled back.

Rollback of `0004_planning_domain_core` first revokes the runtime and backup default table grants
owned by `agency_workload_migrator`. Final rollback of `0001_identity_sessions_admin` revokes explicit
table privileges and schema usage from `agency_workload_runtime` and `agency_workload_backup` before
dropping product objects. The pre-existing schema and unrelated tables remain, without inherited
application-role access.

GoTrue `v2.192.0` has a migration that references PostgreSQL's conventional `postgres` role. The
approved shared cluster was initialized without that role, so bootstrap also creates a locked
`NOLOGIN`, non-superuser compatibility role. It is not an application login.

## Local Services

| Service | Host binding | Purpose |
|---|---|---|
| Fastify | `127.0.0.1:4100` | Sole browser API and authorization boundary |
| GoTrue | `127.0.0.1:9999` | Backend auth integration and health checks |
| Mailpit SMTP | `127.0.0.1:1025` | Local email capture |
| Mailpit UI | `127.0.0.1:8025` | Inspect captured local email |

The application site is exactly `http://localhost:3100`. The only additional auth redirect is
`http://localhost:3100/auth/confirm`; wildcard redirects are not allowed. Signup, autoconfirm,
phone, anonymous, social, SAML, Web3, and custom OAuth providers are disabled. Refresh-token
rotation is enabled with no reuse interval.

Vite proxies browser `/api` traffic only to Fastify at `http://127.0.0.1:4100`. Browser code does not
connect to GoTrue or PostgreSQL.

GoTrue and Mailpit share a project-only bridge network. It is not an `internal` Docker network
because GoTrue must reach the existing host PostgreSQL binding at `host.docker.internal:5434`.

Stop only GoTrue and Mailpit with `npm run auth:down`. This does not stop or restart PostgreSQL.

After any suspected local secret exposure, run
`npm run local:rotate-secrets -- --confirm-rotation`. The confirmation-gated workflow stops the auth
services, rotates all Agency Workload local credentials and signing/session keys, preserves database
objects and data, proves the previous dedicated-role credentials and service token are rejected, and
restarts the services. The shared PostgreSQL superuser is deliberately outside this workflow.

## Production SMTP

Production application mail is disabled in this milestone. Future deployments supply ZeptoMail
through a private runtime secret store using `ZEPTO_SMTP_HOST`, `ZEPTO_SMTP_PORT`,
`ZEPTO_SMTP_USER`, `ZEPTO_SMTP_PASS`, `ZEPTO_SMTP_FROM`, and `ZEPTO_SMTP_SENDER_NAME`. Values never
belong in this repository.

## PostgreSQL Binding Blocker

The currently shared local PostgreSQL container exposes host port `5434` on all IPv4 and IPv6
interfaces. The bootstrap validates that target but does not reconfigure or restart a shared
container. Restrict that binding to loopback before treating the local database network boundary as
secure.
