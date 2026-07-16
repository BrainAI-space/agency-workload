# Web Shell Status

The Vite/React application uses React Router and calls only same-origin Fastify `/api` routes. It does
not call GoTrue, PostgreSQL, Mailpit, or SMTP directly.

## Available Screens

| Route | Status |
|---|---|
| `/login` | Functional invitation-only email request |
| `/verify` | Functional six-digit OTP verification and resend cooldown |
| `/schedule` | Functional real-data planning board, allocation form, Start Finder, conflicts, and mobile brief |
| `/forecast` | Functional 13-week advisory chart and semantic table |
| `/projects` | Functional project/client list, create, complete, and archive workflows |
| `/people` | Functional people list, create, team/role assignment, schedule defaults, and archive |
| `/leave` | Protected milestone placeholder; no leave data yet |
| `/more` | Protected mobile fallback for Leave, account/logout, and role-gated Admin access |
| `/admin/members` | Functional member list, role change, and deactivation |
| `/admin/invitations` | Functional invitation list, creation, delivery status, and resend |
| `/admin/audit` | Functional append-only audit table |
| `/admin/settings` | V1 boundaries and administration navigation; no fake controls |

## Interaction Boundary

- Login email exists only in `sessionStorage` between `/login` and `/verify`.
- CSRF exists only in React memory and is refreshed from the session response after reload.
- No auth token is available to JavaScript; Fastify owns the opaque HttpOnly cookie.
- Backend authorization remains authoritative even when the UI hides owner/admin routes or actions.
- No production records, utilization values, capacity metrics, analytics, or telemetry are seeded.

## Responsive Structure

Desktop uses a 64px horizontal masthead and people-by-week schedule table. Mobile uses the fixed
five-destination model: Plan, Forecast, Projects, People, and More. More exposes Leave, account/logout,
and Admin for owners/administrators. The mobile schedule uses a weekly operational brief instead of
compressing the timeline. All interactive controls target at least 44px, use visible focus states,
and respect reduced-motion preferences.

## Browser Verification

Run `npm run test:browser:smoke` from the repository root. The wrapper selects six random free host
ports and starts a disposable PostgreSQL, GoTrue, and Mailpit stack plus Fastify and a production Vite
preview. It does not use the persistent local application database, GoTrue, or Mailpit services.

Docker must resolve through the effective local context: a Windows `npipe://` endpoint or POSIX
`unix://` socket. The runner rejects `DOCKER_HOST` and `DOCKER_CONTEXT` overrides and any TCP, SSH,
HTTP(S), or malformed endpoint before creating a container, network, or volume. Compose receives only
the generated in-memory smoke configuration and runs with repository `.env` auto-loading disabled.

The root `dev:web` script launches Vite with an explicit `apps/web` root, so `npm --prefix ...` works
from external tool directories and forwards `--host` directly to Vite. Browser, API, and web run as
managed process trees/groups. A shared shutdown controller aborts startup/readiness, waits for the main
run to settle, then stops and rescans the live process registry before and after
`docker compose down -v --remove-orphans`. Repeated signals cannot bypass that cleanup.

On browser failure, inputs and dynamic text are removed before an ignored screenshot and JSON summary
are written under `test-results/browser-smoke/`. The summary contains only fixed stage, readiness,
page, heading, label, browser, and bounded network categories. It excludes raw paths, URLs, query
strings, response bodies, errors, names, emails, OTPs, UUIDs, and user input.
