# Agency Workload

Open-source resource and capacity planning for agencies and service teams.

Agency Workload is being built around one operational question: **who can start, and when?** It
will show effective capacity, leave, confirmed and tentative work, conflicts, and advisory
utilization forecasts without becoming a task manager, timesheet system, payroll product, or
accounting suite.

## Project Status

Pre-alpha foundation with invitation-only OTP authentication, opaque sessions, protected admin APIs,
the first responsive web shell, deterministic capacity math, planning schema, and V1 backend APIs for
catalogs, clients, people, schedules, holidays, leave, projects, allocations, conflicts,
earliest-start search, and advisory forecasts. The web app now connects real people, projects,
allocations, schedule, Start Finder, and forecast workflows. Leave UI, catalog administration, and
CSV import/export remain deferred. Do not use it for production planning.

Current screens:

- Email OTP login and verification
- Real people-by-week schedule with confirmed/tentative allocation forms and conflict indicators
- Functional People and Projects creation/archive workflows
- Start Finder with explicit separate allocation flow
- Real 13-week forecast with chart and semantic table views
- Mobile weekly brief from live capacity data
- Functional member, invitation, resend, role, deactivation, and audit administration
- Honest Leave milestone placeholder

See [`docs/web-shell.md`](docs/web-shell.md) for route and screen status.
See [`docs/planning-domain.md`](docs/planning-domain.md) for formulas, schema, APIs, tested scale, and
the exact deferred boundary.

## Workspaces

```text
apps/api              Fastify business API and security boundary
apps/web              React application
packages/contracts    Shared request and response contracts
packages/db           PostgreSQL migrations and migration runner
```

## Development

Requirements:

- Node.js 24 or newer
- npm 11 or newer
- PostgreSQL 16
- Docker for local Supabase Auth and Mailpit

The Vite application runs on `localhost:3100` and proxies `/api` only to Fastify on
`127.0.0.1:4100`.

Install and verify the current foundation:

```bash
npm ci
npm run verify
npm run test:browser:smoke
```

Local database, GoTrue, and Mailpit setup is documented in
[`docs/local-infrastructure.md`](docs/local-infrastructure.md).
The invitation-only OTP, opaque session, CSRF, RBAC, and admin API boundary is documented in
[`docs/authentication.md`](docs/authentication.md).

## Security

Do not report vulnerabilities in public issues. See [`SECURITY.md`](SECURITY.md). The public
repository contains no live credentials, private operational files, production data, or telemetry.

## License

Agency Workload is licensed under the GNU Affero General Public License v3.0. See [`LICENSE`](LICENSE).
