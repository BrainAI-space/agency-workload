# Authentication Infrastructure

Local authentication runs `supabase/gotrue:v2.192.0` with `axllent/mailpit:v1.30.4`.

GoTrue proves email ownership only. It is not the application authorization boundary. Fastify will
exchange verified auth results for opaque application sessions and enforce roles, origins, and CSRF.
There is no password screen, public registration path, social provider, or direct browser database
access.

## Local URLs

- Application site: `http://localhost:3100`
- Exact permitted auth redirect: `http://localhost:3100/auth/confirm`
- Mailpit UI: `http://127.0.0.1:8025`

The GoTrue host port is reserved for backend development and health checks. Frontend code must not
depend on it.

## Production Email

Mailpit must be replaced by private ZeptoMail runtime configuration in deployed environments. Keep
the values in the deployment secret store. Only these variable names belong in documentation:

- `GOTRUE_SMTP_HOST`
- `GOTRUE_SMTP_PORT`
- `GOTRUE_SMTP_USER`
- `GOTRUE_SMTP_PASS`
- `GOTRUE_SMTP_ADMIN_EMAIL`
- `GOTRUE_SMTP_SENDER_NAME`

Do not add ZeptoMail values to `.env.example`, Compose files, CI variables available to forks, test
fixtures, logs, or the public mirror.
