# Web Shell Status

The Vite/React application uses React Router and calls only same-origin Fastify `/api` routes. It does
not call GoTrue, PostgreSQL, Mailpit, or SMTP directly.

## Available Screens

| Route | Status |
|---|---|
| `/login` | Functional invitation-only email request |
| `/verify` | Functional six-digit OTP verification and resend cooldown |
| `/schedule` | Protected responsive shell and honest empty planning board |
| `/forecast` | Protected milestone placeholder; no forecast data yet |
| `/projects` | Protected milestone placeholder; no project data yet |
| `/people` | Protected milestone placeholder; no schedulable people data yet |
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

Run `npm run test:browser:smoke` from the repository root. The wrapper requires ports `4100` and
`3100` to be free, starts Fastify and Vite with the repository as their working directory, verifies
HTTP readiness, runs the Mailpit OTP smoke, and terminates each full process tree on Windows.

The root `dev:web` script launches Vite with an explicit `apps/web` root, so `npm --prefix ...` works
from external tool directories and forwards `--host` directly to Vite. On smoke failure, the runner
clears form values and redacts email/code-like page text before writing an ignored screenshot and
structured summary under `test-results/browser-smoke/`. The summary contains paths, statuses,
headings, labels, and error categories only.
