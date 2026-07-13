# Authentication Infrastructure

Local authentication runs `supabase/gotrue:v2.192.0` with `axllent/mailpit:v1.30.4`.

GoTrue proves email ownership only. It is not the application authorization boundary. Fastify
generates a six-digit email OTP through GoTrue's server-only admin API, sends it through a fixed
application mailer, discards GoTrue tokens after verification, and issues opaque sessions.
There is no password screen, public registration path, social provider, or direct browser database
access.

## Local URLs

- Application site: `http://localhost:3100`
- Exact permitted auth redirect: `http://localhost:3100/auth/confirm`
- Mailpit UI: `http://127.0.0.1:8025`

The GoTrue host port is reserved for backend development and health checks. Frontend code must not
depend on it.

## Production Email

Mailpit must be replaced by private ZeptoMail runtime configuration in deployed environments.
Production application delivery is disabled in this milestone. These future variable names belong
in documentation, while values belong only in the deployment secret store:

- `ZEPTO_SMTP_HOST`
- `ZEPTO_SMTP_PORT`
- `ZEPTO_SMTP_USER`
- `ZEPTO_SMTP_PASS`
- `ZEPTO_SMTP_FROM`
- `ZEPTO_SMTP_SENDER_NAME`

Do not add ZeptoMail values to `.env.example`, Compose files, CI variables available to forks, test
fixtures, logs, or the public mirror.
