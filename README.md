# Agency Workload

Open-source resource and capacity planning for agencies and service teams.

Agency Workload is being built around one operational question: **who can start, and when?** It
will show effective capacity, leave, confirmed and tentative work, conflicts, and advisory
utilization forecasts without becoming a task manager, timesheet system, payroll product, or
accounting suite.

## Project Status

Pre-alpha foundation. The repository is public so architecture, security, and product decisions can
be reviewed as they are implemented. Do not use it for production planning yet.

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

Install and verify the current foundation:

```bash
npm ci
npm run verify
```

Local database and authentication setup will be documented before the first usable milestone.

## Security

Do not report vulnerabilities in public issues. See [`SECURITY.md`](SECURITY.md). The public
repository contains no live credentials, private operational files, production data, or telemetry.

## License

Agency Workload is licensed under the GNU Affero General Public License v3.0. See [`LICENSE`](LICENSE).
