# Local Database, Auth, And Email

Agency Workload uses a dedicated PostgreSQL database and self-hosted GoTrue for email ownership.
Mailpit captures local email. Supabase CLI, Studio, PostgREST, Realtime, Redis, and an ORM are not
part of this foundation.

## Start Locally

With the approved PostgreSQL 16 container already running on host port `5434`:

```bash
npm ci
npm run config:check
npm run local:bootstrap
npm run config:check:runtime
npm run auth:up
npm run auth:health
```

The bootstrap command creates an ignored `.env`, generates development-only values without printing
them, and prepares `agency_workload`. Running it again keeps existing secrets and data. It never
drops a database or schema.

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

GoTrue `v2.192.0` has a migration that references PostgreSQL's conventional `postgres` role. The
approved shared cluster was initialized without that role, so bootstrap also creates a locked
`NOLOGIN`, non-superuser compatibility role. It is not an application login.

## Local Services

| Service | Host binding | Purpose |
|---|---|---|
| GoTrue | `127.0.0.1:9999` | Backend auth integration and health checks |
| Mailpit SMTP | `127.0.0.1:1025` | Local email capture |
| Mailpit UI | `127.0.0.1:8025` | Inspect captured local email |

The application site is exactly `http://localhost:3100`. The only additional auth redirect is
`http://localhost:3100/auth/confirm`; wildcard redirects are not allowed. Signup, autoconfirm,
phone, anonymous, social, SAML, Web3, and custom OAuth providers are disabled. Refresh-token
rotation is enabled with no reuse interval.

GoTrue and Mailpit share a project-only bridge network. It is not an `internal` Docker network
because GoTrue must reach the existing host PostgreSQL binding at `host.docker.internal:5434`.

Stop only GoTrue and Mailpit with `npm run auth:down`. This does not stop or restart PostgreSQL.

After any suspected local secret exposure, run
`npm run local:rotate-secrets -- --confirm-rotation`. The confirmation-gated workflow stops the auth
services, rotates all Agency Workload local credentials and signing/session keys, preserves database
objects and data, proves the previous dedicated-role credentials and service token are rejected, and
restarts the services. The shared PostgreSQL superuser is deliberately outside this workflow.

## Production SMTP

Deployed environments supply ZeptoMail through a private runtime secret store. The configuration
names are `GOTRUE_SMTP_HOST`, `GOTRUE_SMTP_PORT`, `GOTRUE_SMTP_USER`, `GOTRUE_SMTP_PASS`,
`GOTRUE_SMTP_ADMIN_EMAIL`, and `GOTRUE_SMTP_SENDER_NAME`. Values never belong in this repository.

## PostgreSQL Binding Blocker

The currently shared local PostgreSQL container exposes host port `5434` on all IPv4 and IPv6
interfaces. The bootstrap validates that target but does not reconfigure or restart a shared
container. Restrict that binding to loopback before treating the local database network boundary as
secure.
