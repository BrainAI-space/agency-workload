# Authentication And Administration

Fastify is the only browser API. Browser code must never call GoTrue, Mailpit, SMTP, or PostgreSQL.

## Email OTP Flow

1. `POST /api/v1/auth/request-code` accepts only an email address and always returns the same response.
2. Fastify checks an active membership or pending invitation, applies email/IP/resend limits, and asks
   GoTrue's server-only admin API to generate a six-digit email OTP.
3. The fixed application mailer sends the code. Local delivery goes only to Mailpit.
4. `POST /api/v1/auth/verify-code` verifies the code with GoTrue, checks or accepts the app membership,
   discards GoTrue access and refresh tokens, and creates an opaque application session.

Codes expire after ten minutes and allow at most five attempts. The API stores keyed email/IP hashes,
not OTPs. Responses, audit details, and application logs exclude email addresses, codes, identity
tokens, session tokens, and CSRF tokens.

Public request-code traffic has a strict ten-per-minute route IP limit in addition to database email,
IP, and resend limits. Every request-code result is padded to a 200ms minimum plus bounded 0-25ms
jitter, including known, unknown, and disabled identities.

## Sessions And CSRF

Production uses `__Host-agency_workload_session`. Development uses the separate
`agency_workload_session_dev` name. Both are `HttpOnly`, `SameSite=Lax`, `Path=/`, and omit `Domain`;
production also requires `Secure`. PostgreSQL stores only the SHA-256 token hash. Sessions have a
30-minute idle expiry, 12-hour absolute expiry, and a five-session maximum.

`GET /api/v1/auth/session` and `GET /api/v1/auth/csrf` return a synchronizer token derived for the
current session. Every authenticated state change requires exact `Origin`, JSON content type, and
`X-CSRF-Token`. Logout is POST-only and revokes the session.

## Roles And Admin APIs

Roles are `owner`, `admin`, `planner`, `member`, and `viewer`. Owner and admin can access the admin
API. Only owners can assign owner or admin. Admins can assign planner, member, or viewer. Self-role
changes, self-disable, cross-organization identifiers, and removal of the final active owner are
rejected transactionally.

- `GET /api/v1/admin/memberships`
- `GET /api/v1/admin/invitations`
- `POST /api/v1/admin/invitations`
- `POST /api/v1/admin/invitations/:id/resend`
- `PATCH /api/v1/admin/memberships/:id/role`
- `POST /api/v1/admin/memberships/:id/deactivate`
- `POST /api/v1/admin/sessions/:id/revoke`
- `GET /api/v1/admin/audit`

Invitations create login access only. They do not create a schedulable person. Delivery state is
recorded as pending, sent, or failed. Pending invitations can be resent by owner/admin at most once
per minute and five times total. Accepted, revoked, and expired invitations cannot be resent.

Role changes are effective on the next request because every session lookup joins the current active
membership role. A role change does not revoke the session. Deactivation revokes all sessions in the
same transaction. Session revocation and its audit event are also one transaction.

## Single-Organization V1

V1 enforces one active membership per user and one pending invitation per normalized email across the
installation. Forward migration checks reject pre-existing conflicts without deleting rows. The two
partial unique indexes are deliberate V1 constraints and can be removed by a future reviewed
multi-organization migration.

## Explicit Commands

```bash
npm run db:migrate
npm run auth:bootstrap-owner
```

Migrations never run on API startup. Owner bootstrap is a local one-shot CLI and is not exposed over
HTTP. It uses `BOOTSTRAP_EMAIL` only when no active owner exists.

Rollback is break-glass only. Development requires
`npm run db:migrate -- --down --confirm-down`. Production additionally requires
`--break-glass-production`.

## Production Mail Boundary

Production sending is disabled in this milestone. Future private deployment configuration uses these
names only: `ZEPTO_SMTP_HOST`, `ZEPTO_SMTP_PORT`, `ZEPTO_SMTP_USER`, `ZEPTO_SMTP_PASS`,
`ZEPTO_SMTP_FROM`, and `ZEPTO_SMTP_SENDER_NAME`. Values belong only in the deployment secret store.
