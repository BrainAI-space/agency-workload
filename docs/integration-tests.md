# Disposable Integration Tests

## PostgreSQL Integration Suites

Run each DB-backed suite independently:

```bash
npm run test:db:integration
npm run test:admin:integration
npm run test:planning:integration
npm run test:extended:integration
```

All four commands use the generic disposable PostgreSQL harness and do not load `.env`. Every command:

1. Rejects `DOCKER_HOST`, `DOCKER_CONTEXT`, and `DOCKER_CONFIG`, inspects the effective Docker endpoint,
   and continues only for a local Windows named pipe or POSIX Unix socket.
2. Generates a fresh 256-bit token. Its first 128 bits identify the exact Compose project, database,
   process marker, PostgreSQL container, volume, and networks for that one run.
3. Binds one random loopback PostgreSQL port from `49152-60999`, excluding persistent service defaults.
   GoTrue and Mailpit are not started and expose no host ports.
4. Uses `COMPOSE_DISABLE_ENV_FILE=true`, starts only `postgres`, and verifies its service and generated
   project labels before creating dedicated roles and the generated database.
5. Starts one registered Vitest file with one registered integration flag. Arbitrary suites, paths,
   child flags, cross-suite markers, and additional integration flags are refused.
6. Stops the managed Vitest tree, runs `docker compose down -v --remove-orphans`, then rescans the exact
   process marker, Compose project resources, and generated host port before returning.

Suite setup remains explicit:

| Suite | Database identity | Harness migration | Owner fixture | Registered test file |
| --- | --- | --- | --- | --- |
| DB | Migrator | No; the suite exercises fresh/rerun/failure/rollback paths itself | No | `packages/db/test/integration.test.ts` |
| Admin | Runtime | Yes | Yes | `apps/api/test/admin.integration.test.ts` |
| Planning | Runtime | Yes | Yes | `apps/api/test/planning.integration.test.ts` |
| Extended | Runtime | Yes | No | `apps/api/test/extended.integration.test.ts` |

The admin and planning owner fixture supplies the prerequisite active owner membership and verifies it
with a fail-closed SQL assertion. It does not test production `bootstrap-owner.ts`, which requires
GoTrue. Auth/browser integration still covers that path. The separate persistent-stack
`npm run test:bootstrap:integration` operation is guarded by the exact Git origin. In the private
canonical checkout it spawns only `tools/test/bootstrap.integration.mjs --integration` with a fixed
five-minute ceiling. That operation runs bootstrap, applies the real migration registry, reruns
bootstrap, and then verifies role/ownership boundaries. It also requires zero runtime or backup
privileges across all seven PostgreSQL table privilege types on `app.schema_migrations`, normal runtime
DML and backup read access on application tables, and runtime `SELECT`/`INSERT` but no `UPDATE`/`DELETE`
on `app.audit_events`. The disposable suites do not absorb this persistent bootstrap verifier.

The public origin refuses bootstrap integration before loading the mutation script or touching `.env`,
Docker, or PostgreSQL. The fixed refusal explains that this verifies the canonical persistent local
role bootstrap and is not a public clean-clone gate. Unknown origins fail closed. Public contributors
use `npm run verify` as the normal clean-clone gate.

Each enabled module calls `assertExactPostgresIntegrationBoundary` before `loadConfig`, pool creation,
or Docker helper use. The assertion recomputes an HMAC-SHA256 manifest from the full token and validates
the exact suite, flag, marker, Compose file/project, and generated database host/name/port/user/URL.
Persistent names and ports, URL query/hash options, alternate database variables, any `PG*` override,
Docker/Compose controls, extra flags, and cross-suite markers fail before database or Docker I/O.

Admin alone needs application fields for `loadConfig`. Its app, GoTrue, session, and SMTP values are
inert local values or token-derived values included in the signed manifest. They are not inherited from
`.env`; persistent app/auth/SMTP defaults remain forbidden. No auth or mail service is contacted.

Test-only privileged SQL in DB, planning, and extended revalidates the full boundary through
`runDisposablePostgresSql`, then invokes only:

```text
docker compose --project-name <generated> -f infra/compose.smoke.yml exec -T postgres psql ...
```

SQL travels over stdin. Passwords are absent from arguments and output. The helper has its own
allowlisted Compose parsing environment and disables implicit `.env` loading.

The DB suite proves fresh migration, rerun idempotency, exact-prefix history refusal in both
directions, legacy upgrade/backfill, unchanged up-checksum drift refusal, forward and rollback
down-checksum drift refusal, failed up/down transaction rollback, explicit runtime/backup grant and
denial matrices, rollback ACL/default-privilege cleanup, explicit down migration, and conflict
reporting inside disposable schemas. A one-privilege probe also proves PostgreSQL's comma-separated
privilege check cannot stand in for requiring all four privileges. Admin retains authorization,
cross-organization, invitation, session, audit rollback, and concurrency coverage.

Planning allocation/parent races and extended client/project races use a dedicated transaction to
hold the exact target row. Both operations start, a recursive `pg_blocking_pids` query must observe
two blocked backend chains, and both promises must still be unsettled before the holder commits. The
tests then require one valid winner, one documented business rejection, no `40P01`, and the final
parent invariant. A deliberately sequential planning control must fail the overlap proof. Database
and admin uniqueness races use only a small promise-start barrier and assert both operations were
issued before awaiting; they do not claim observed lock overlap.

Compose disposal is the cleanup boundary. The suites do not delete persistent rows or use
`session_replication_role`. One monotonic 240-second deadline covers the whole operation; cleanup gets a
separate 30-second budget. `SIGINT` and `SIGTERM` share the idempotent cleanup path, with POSIX process
groups and exact Windows command-line markers covering descendants.

On 2026-07-16, the current 14-test migration suite passed twice after the history, drift, grant, and
rollback-ACL audit fixes. Vitest file durations were 23.60 and 25.82 seconds. Both disposable harness
runs reported successful removal of their exact resources.

## Auth Integration

Run:

```bash
npm run test:auth:integration
```

The command does not load `.env`. It generates every credential and target internally, and uses a fixed
exclusion set for the canonical persistent/default ports `1025`, `3100`, `4100`, `5432`, `5434`,
`8025`, and `9999`. It then uses the same disposable infrastructure primitives as the browser smoke:

1. Validate the effective Docker endpoint is a local Windows named pipe or POSIX socket.
2. Generate a 256-bit run token. Its first 128 bits are the fixed suffix for the Compose project,
   database, owner email, and auth process marker.
3. Select every run host port from the dedicated `49152-60999` range. All six allocated ports are
   mutually distinct and exclude persistent defaults `5434`, `9999`, `8025`, and `1025`.
4. Start isolated PostgreSQL and Mailpit from `infra/compose.smoke.yml`.
5. Create dedicated roles/database and apply application migrations.
6. Start isolated GoTrue and bootstrap the unique owner.
7. Run only `apps/api/test/auth.integration.test.ts` with `AW_AUTH_INTEGRATION=1`, the run token,
   the exact disposable marker/Compose project, and separate actual plus expected app, database,
   GoTrue, Mailpit, SMTP, owner, service-key, and session fields.
8. Stop the managed Vitest process tree, run `docker compose down -v --remove-orphans`, then rescan the
   marker, containers, networks, volume, and all allocated ports.

Resource absence scans share one fixed Docker command builder: container and network lists format the
supported ID field, while volume lists format the supported name field. A read-only local CLI test
executes all three shapes against a nonexistent project label.

The auth test validates every actual target against its generated expected value before `loadConfig`,
`Pool`, Mailpit deletion, or a database query. PostgreSQL URLs reject query/hash options, wrong users,
paths, hosts, or ports. Both test-side database URLs must use the exact random loopback mapping. GoTrue,
Mailpit, SMTP, owner identity, service/session values, marker, token, and Compose project must also match.

The runner serializes expected fields in one fixed key order and computes HMAC-SHA256 with the full run
token. The test recomputes that proof and compares it with `timingSafeEqual` before validating actual
targets. Matching actual/expected persistent defaults, duplicate ports, out-of-range ports, altered
suffixes, malformed tokens, wrong proofs, and URL query overrides are all rejected. Token, proof, and
target URLs are never logged.

Mailbox clearing is permitted only inside this dedicated Mailpit instance. OTP polling has one overall
five-second deadline. Every message-list or raw-message fetch has its own abort controller capped at
500ms, consumes the body inside that scope, then is cancelled. Messages are selected by exact recipient
and read by ID. No matching message produces one fixed timeout error.

The disabled-user test removes the known user's prior request before disabling the account and proves
the disabled request creates neither an `auth_requests` row nor mail. The suite does not delete GoTrue
users or use superuser replication-role cleanup because stack disposal is the cleanup boundary.

The parent harness starts one monotonic 180-second main deadline at function entry, before token/port
allocation. That single budget covers every setup stage and the managed Vitest child. Every synchronous
Docker, psql, migration, and bootstrap operation receives the smaller of its step cap and the remaining
main budget. Port allocation and async startup steps check the same deadline before and after work; the
Vitest wait receives only the remaining time. The child launcher contains no timer or kill logic.

Cleanup starts a separate 30-second monotonic budget even when the main budget is exhausted. Process
termination, Compose teardown, CIM marker scans, Docker resource scans, and port closure checks consume
that cleanup budget. The package awaits cleanup and final residual verification before returning a main
timeout or signal result.

The initial 120-second whole-operation budget was measured and rejected: on the 2026-07-16 Windows
verification host it expired during isolated stack setup before Vitest started, while cleanup completed
successfully. The 180-second ceiling is the smallest selected whole-operation budget above that measured
setup path; it does not change the individual 15/30-second test ceilings.

The four tests retain their existing 15 or 30 second ceilings. Across two serial 2026-07-16 Windows
verification runs, individual tests completed in approximately 4.3 to 15.6 seconds and the Vitest file
completed in about 33.1 to 40.2 seconds. No higher per-test timeout was needed.

An external read-only verifier compared every persistent `app`/`auth` base-table row count and the
persistent Mailpit message-ID set before and after both runs. They were unchanged; no values were
printed.

The final review verification repeated two serial disposable runs with the complete expected-target
manifest. Both passed, retained the existing per-test ceilings, preserved persistent state, and left no
Compose container, network, or volume.

This suite covers real GoTrue email OTP, opaque sessions, CSRF/logout, generic unknown/disabled-user
behavior, resend/expiry behavior, and email-only invitation acceptance. It does not cover browser UI or
planning workflows.

The public sync allowlist explicitly includes the child launcher and every auth harness dependency, so
future public verification cannot omit part of the disposable test path.
