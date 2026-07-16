# Disposable Browser Smoke

**Status:** Verified
**Created:** 2026-07-16
**Updated:** 2026-07-16

## Goal

`npm run test:browser:smoke` exercises real email OTP login and the planning shell without connecting
to the persistent Agency Workload PostgreSQL database, GoTrue service, or Mailpit service.

## Isolation

The package script invokes Node without `--env-file`. The runner does not read the repository `.env`.
It generates all credentials and targets internally and excludes the fixed canonical
persistent/default ports `1025`, `3100`, `4100`, `5432`, `5434`, `8025`, and `9999` when selecting six
disposable host ports. It does not read, derive from, fingerprint, or connect with persistent database
credentials or persistent service state.

Before any Docker mutation, the runner rejects `DOCKER_HOST` and `DOCKER_CONTEXT` overrides, inspects
the effective Docker context through fixed CLI arguments, and requires a local Windows `npipe://`
endpoint or POSIX `unix://` socket. TCP, SSH, HTTP(S), and malformed endpoints fail closed. Docker and
Compose alone may receive the validated Docker CLI environment. Compose sets
`COMPOSE_DISABLE_ENV_FILE=true`, so `infra/compose.smoke.yml` receives only explicit generated values
and never auto-loads the repository `.env`.

Each run generates a validated random suffix, bootstrap email, PostgreSQL role passwords, GoTrue JWT
secret/service token, session secret, Compose project, container names, network name, volume name,
database name, and six free host ports. Values remain in memory and are never printed.

`infra/compose.smoke.yml` owns all stateful services for the run:

- pinned PostgreSQL 16 with a Compose-managed named volume;
- pinned GoTrue with its own `auth` schema in that PostgreSQL instance;
- pinned Mailpit with temporary storage;
- one Compose-only internal service network;
- one Compose-managed host-access bridge required by Docker Desktop for loopback publication;
- loopback-only host bindings for PostgreSQL, GoTrue, SMTP, and Mailpit.

The runner starts PostgreSQL and Mailpit first. It creates only the application owner, migrator,
runtime, GoTrue, backup, and locked GoTrue-compatibility roles inside the disposable PostgreSQL
container. SQL reaches that container only through fixed `docker compose exec -T postgres psql`
arguments and stdin. The runner then applies migrations, starts GoTrue, bootstraps the unique owner,
builds the production web bundle, and starts API plus Vite preview with run-specific environments.

## Cleanup

Resource identifiers, one shutdown `AbortController`, one live child registry, and one idempotent
cleanup function exist before startup. The first `SIGINT` or `SIGTERM` marks shutdown requested and
aborts startup, readiness, and managed-child waits. Repeated signals do nothing. The signal path waits
for the main startup/run promise to settle before invoking cleanup, so startup cannot add a resource
while cleanup is scanning. Guarded startup steps check shutdown before work, yield after synchronous
work so queued signals can run, and check again before the next step. Cleanup failure exits nonzero.

Cleanup:

1. Stops browser, API, and web process trees in that order.
2. On Windows, queries PID plus command line through CIM, accepts only exact role-marker arguments,
   and re-queries the same PID immediately before each bounded `taskkill /PID ... /T /F`. A known
   exited/recycled leader is never targeted. It repeats exact-marker scans until zero or fails cleanup.
3. On POSIX, sends `SIGTERM` to the known detached process group even if its leader exited, verifies
   group absence, then sends `SIGKILL` and verifies again if needed.
4. Runs `docker compose down -v --remove-orphans` for the random project.
5. Verifies its containers, internal network, host-access bridge, and named volume are absent.
6. Verifies all six run-specific host ports are closed.
7. Re-reads the final live child registry and rechecks every Windows marker or POSIX group, then
   rescans Compose resources and ports once more.

Any cleanup or absence-check failure fails the command. Persistent state is preserved by construction:
the smoke runner has no connection or endpoint to it.

The browser script is an asynchronous tracked child, not a synchronous subprocess. Its Node process
and Chromium descendants use the same managed Windows process tree or detached POSIX process group as
API and web. A 120-second browser deadline invokes the shared memoized cleanup, kills and waits for
the full browser tree/group, then stops API/web and tears down Compose. A normal browser exit cancels
the deadline and propagates its status before cleanup, so an exited PID is never killed after reuse.

## Browser Truth

The web application is built and served as a production Vite preview. This avoids React development
Strict Mode's synthetic first-mount cancellations. Every failed API transport is fatal.

Startup probes reject redirects, require the exact final URL and media type, use bounded abort
deadlines, and require the API health body to be exactly `{status: 'ok'}`. Desktop and mobile schedule
readiness each take a baseline before navigation and require a new `GET` response with status exactly
`200` for each core pathname:

- `/api/v1/planning/settings`
- `/api/v1/people`
- `/api/v1/projects`
- `/api/v1/allocations`
- `/api/v1/schedule`

Optional catalog requests may complete but cannot substitute for a core destination.

### Current Boundary

This smoke proves the disposable infrastructure lifecycle, real email OTP authentication, protected
desktop/mobile navigation, browser-storage boundaries, exact startup health, settled core schedule API
readiness, admin member-list readiness, and absence of unexpected API/browser failures in those paths.

It does not create or mutate real planning records. End-to-end people/project/allocation creation,
Leave workflows, generated conflict handling, and conflict acknowledgement remain release-smoke
follow-up work. Passing this command is not evidence that those record-level workflows are release
ready.

## Child Environments

Every child receives a fresh allowlisted environment plus the minimum operating-system variables
needed to launch:

- Compose: generated PostgreSQL and GoTrue values plus Compose ports/origins.
- Migration: only the disposable migrator URL.
- Owner bootstrap: disposable runtime/auth/session values and bootstrap email.
- API: disposable runtime/auth/session/SMTP values, never migration or PostgreSQL-superuser values.
- Web: preview port and API proxy origin only.
- Browser: app origin, isolated Mailpit origin, and bootstrap email only.

Chromium never inherits database URLs, migration credentials, PostgreSQL credentials, JWT/service
keys, session secrets, or Docker/Compose controls. API and web also receive no Docker control
variables. The browser's only additional values are its unique process marker and isolated temporary
profile path, used to prove Windows descendant cleanup.

## Failure Evidence

Each browser failure keeps an ignored timestamped screenshot and JSON summary under
`test-results/browser-smoke/`. Inputs are cleared. Dynamic text, names, emails, OTPs, UUIDs, URLs,
query strings, bodies, and raw errors are never written. Summaries use fixed stage, page, heading,
label, browser, and network categories only. Screenshots retain only allowlisted fixed interface text.
Runner failures emit only fixed orchestration stage and category labels.

The real Windows process-tree test waits for a validated `READY:<marker>:<descendant-pid>` line before
cleanup. After cleanup it independently verifies that exact descendant PID and marker are absent. The
test fails rather than passing if the child/grandchild handshake never arrives.

## Verification

```bash
npm run test:tools
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm audit --audit-level=moderate
git diff --check
npm run test:browser:smoke
npm run test:browser:smoke
```

The browser runs are serial. External read-only verification may compare persistent application and
GoTrue table row counts plus persistent Mailpit message IDs before and after the runs. That verifier
is deliberately outside the browser smoke runner and must print only a fixed unchanged/changed result.

## Verification Record

### 2026-07-16

- Tool tests covered coordinated shutdown during delayed startup, live-registry cleanup, local/remote
  Docker endpoint validation, Compose `.env` suppression, child-environment stripping, persistent
  signals, spawn errors, exact readiness, browser timeout/nonzero exit, exact Windows marker/PID
  revalidation, Windows/POSIX cleanup, GET/200 destination accounting, evicted failures, unrelated
  aborts, and missing destinations.
- A real Windows process-tree test used the production run-marker shape and production CIM marker-list
  branch, waited for an explicit leader/descendant READY handshake, removed both processes, and
  independently verified the reported descendant PID and exact marker were absent. Non-Windows skips
  that real test; POSIX process-group escalation and exited-leader behavior retain pure injected
  coverage.
- Syntax: every changed smoke runner, helper, browser, and test module passed `node --check`.
- Format and lint completed with no findings.
- TypeScript: all five workspaces passed.
- Normal tests passed; integration-only suites remained behind their explicit commands.
- Build: all five workspaces passed.
- Audit: zero known vulnerabilities at the moderate threshold.
- Diff whitespace: clean.
- Browser smoke: two final runs passed serially.
- Both runs accepted the effective local Windows named-pipe Docker endpoint before mutation.
- PID ancestry verification found no surviving Node, Chrome, or Chromium descendant from either smoke
  command tree.
- External read-only before/after verification found persistent service port states, application and
  GoTrue table row counts, and Mailpit message IDs unchanged. No values were printed.
- Each smoke verified its Compose containers, two networks, named volume, process trees, and six host
  ports were absent after cleanup.
