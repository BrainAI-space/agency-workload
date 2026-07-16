# Planning Domain Core

**Status:** Verified V1 backend boundary with core planner UI integration.

This milestone establishes deterministic calendar math, the complete V1 planning schema, and the V1
planning backend APIs. The web app consumes people, projects, allocations, schedule, earliest-start,
and forecast APIs. Leave UI and catalog administration remain deferred.

## Calendar And Minutes

- Planner dates are strict `YYYY-MM-DD` civil dates converted to integer day ordinals.
- The engine never parses planner dates with `new Date('YYYY-MM-DD')` and does not depend on the host
  timezone.
- Capacity, leave, and allocations use integer minutes only.
- Effective schedules contain seven ISO weekdays (`1` Monday through `7` Sunday) and cannot overlap.
- Person active ranges and allocation ranges are inclusive.
- Holidays reduce capacity to zero. Leave is ignored on holidays and otherwise summed then capped at
  scheduled capacity, so overlapping entries cannot produce negative capacity.

## Allocation Formula

Both allocation modes apply only when the person's baseline weekly schedule has positive minutes for
the date. A normal non-working weekday or weekend therefore has zero allocation demand.

`minutes_per_day` uses its integer minute value on baseline working days. `capacity_percent` uses the
baseline scheduled minutes before holiday and leave deductions:

```text
allocation_minutes = round_half_up(baseline_scheduled_minutes * percent / 100)
```

Round-half-up is implemented with integer division. Percent is stored as a whole integer and may
exceed 100 up to 1000 to represent explicit over-allocation.

Holiday or leave on an otherwise scheduled working day reduces effective capacity but does not erase
allocation demand. The resulting shortage remains visible as confirmed or potential overbooking.

Confirmed and tentative minutes remain separate:

```text
confirmed_available = max(0, capacity - confirmed)
scenario_available  = max(0, capacity - confirmed - tentative)
confirmed_overbook  = max(0, confirmed - capacity)
potential_overbook  = max(0, confirmed + tentative - capacity)
```

Billable and internal utilization use confirmed minutes. Zero capacity returns `null` (N/A), not
zero percent. Range utilization first sums all minute numerators and denominators, then calculates
the percentage. Daily percentages are never averaged.

Conflicts are derived, not stored. Their stable fingerprint includes person, date, severity,
capacity, and confirmed minutes. Confirmed-conflict fingerprints exclude tentative demand, so
changing tentative work cannot invalidate an acknowledgement of an unchanged confirmed conflict.
Potential-conflict fingerprints additionally include tentative minutes because that demand is part
of the potential overbook source.

## Earliest Start

The pure engine filters by delivery role, team, and required tags. It searches from `notBefore` for
the requested workday count and daily available minutes under the confirmed or confirmed-plus-
tentative scenario. Weekends, holidays, and leave extend the completion date. A calendar gap longer
than seven days breaks the sequence. Search is explicitly bounded to 1-730 calendar days.

`POST /api/v1/earliest-start` exposes this search with a 1-60 workday bound and maximum 365-day
horizon. Results contain person, start/end, minimum headroom, `continuousAllocationSafe`, and a
stable explanation. `continuousAllocationSafe` is true only when adding the requested fixed
`dailyMinutes` allocation on every civil date from result start through result end does not exceed
that date's availability under the requested scenario. The additional demand uses the normal
allocation formula: baseline-zero weekends add zero demand and are safe, while holidays or full-day
leave on otherwise scheduled weekdays retain fixed demand and make a continuous allocation unsafe
when availability is insufficient. Search never creates an allocation.

## Schema

Forward migration `0004_planning_domain_core` adds:

- organization planning defaults
- teams, delivery roles, and tags
- people, person tags, and optional membership/person links
- effective work schedule versions and weekdays
- holiday calendars, dates, and person assignments
- leave types and entries
- clients and projects
- confirmed/tentative allocations
- conflict acknowledgements

Every planning table carries `organization_id`. Composite same-organization foreign keys protect
planning relationships. Mutable records use positive `row_version` values. Schedules use a
transactional overlap trigger with a per-person advisory lock. Runtime and backup grants are applied
without widening audit-table permissions.

Forward migration `0009_down_migration_checksums` preserves the original up checksums for migrations
`0001` through `0008` and adds a separate exact-down-SQL binding. Existing installations must run the
normal forward migration once before rollback. See `docs/local-infrastructure.md` for the stable
refusal and operator sequence.

## HTTP Boundary

Implemented under `/api/v1`:

- `GET|PATCH /planning/settings`
- `GET|POST /people`
- `GET|PATCH /people/:id`
- `POST /people/:id/archive`
- `POST /people/:id/work-schedules`
- `GET|POST /projects`
- `GET|PATCH /projects/:id`
- `POST /projects/:id/archive`
- `POST /projects/:id/complete`
- `GET|POST /allocations`
- `PATCH|DELETE /allocations/:id`
- `GET /schedule?start=...&end=...&scenario=...`
- teams, delivery roles, and tags list/create/update/archive routes
- clients list/create/update/archive routes
- holiday calendar list/create/update/archive, holiday date add/remove, and person assignment routes
- leave type list/create/update/archive and leave list/create/update/delete routes
- `GET /conflicts` and acknowledge/unacknowledge routes
- `POST /earliest-start`
- `GET /forecast`

All reads use the session organization. Cross-organization IDs return 404. Owner, admin, and planner
can mutate core planning records; member and viewer are read-only for this boundary. Mutations require
the existing exact-origin and CSRF checks and append audit events in the same transaction. Stale
`row_version` writes return 409. People or projects with current/future allocations cannot be
archived or completed.

Every route has an explicit TypeBox success/error response schema. Core list endpoints return active
people, non-archived projects, and non-deleted allocations only; archive/delete timestamps are not
part of planner responses. Person work email is omitted for member and viewer sessions. Owner, admin,
and planner may receive the optional work email; membership identity email remains a separate admin
API concern.

Allocations cannot be created or retargeted to archived, completed, or cancelled projects. A project
target end requires a target start, and target ranges remain inclusive. Archive/complete guards derive
the current civil date from the organization's validated IANA timezone. This avoids UTC boundary
errors for organizations such as `America/Los_Angeles` and `Asia/Dhaka`.

Catalog and holiday-calendar structure (calendars, dates, and person assignment) is owner/admin
managed; every role can read active catalogs. Clients and arbitrary-person leave are
owner/admin/planner managed. Members may
create, update, and delete leave only for their active `memberships.linked_person_id`. Viewer leave
responses, and member responses for other people, expose unavailable spans only: person and inclusive
dates without leave type or partial-minute details. V1 stores no reason, medical note, balance, or
approval state.

Leave update and deletion authorize against the existing locked record, never the submitted person
ID. A member cannot move a leave record to another person or take over another person's record.
Planner/admin/owner reassignment requires an active same-organization person.

Active-name duplicates for teams, delivery roles, tags, clients, holiday calendars, and leave types
return stable 409 codes. Duplicate dates within a holiday calendar return `holiday_date_conflict`.

One active holiday calendar can be assigned per person. Holiday and leave mutations affect the next
schedule, conflict, earliest-start, and forecast calculation immediately.

Current conflicts are derived for a bounded range and optional person/team/role filters. Responses
identify confirmed or potential overbook, explain the capacity source, and carry stable fingerprints.
Owner/admin/planner may acknowledge or unacknowledge a fingerprint; members/viewers read only. A
changed source produces a new fingerprint. This API covers capacity overbooking only, not every
possible business conflict.

Forecast defaults to the organization's configured 13 weeks and is bounded at 52. Weeks use the
organization timezone and week start. Each row contains effective capacity; confirmed and tentative
billable/internal minutes; confirmed and potential utilization; overbook; and billable target gap.
The response includes generation time and an assumptions sentence. It contains no rates, revenue, or
other financial fields.

## Migration 0008 Operator Gate

Migration `0008_forecast_horizon_v1_bounds` is intentionally non-destructive. It stops and rolls back
when any existing organization has a forecast horizon outside the new 13-52 week range; it never
clamps or rewrites that value automatically.

Identify only affected organizations and their current values:

```sql
SELECT settings.organization_id, organization.slug, settings.forecast_horizon_weeks
FROM app.organization_planning_settings settings
JOIN app.organizations organization ON organization.id = settings.organization_id
WHERE settings.forecast_horizon_weeks NOT BETWEEN 13 AND 52
ORDER BY settings.organization_id;
```

Resolve each result through `PATCH /api/v1/planning/settings` with the current full settings payload
and `rowVersion`. If the API cannot be used during an upgrade, use a separately reviewed transaction
that locks only the affected settings row, writes an approved 13-52 value, increments `row_version`,
and updates `updated_at`. Do not bulk-update unrelated organizations. Then rerun `npm run db:migrate`;
the migration will add the 13-52 database constraint once no blocking values remain.

## Verification And Supported Dataset

- 22 named golden cases derived from the supplied milestone rules
- two fixed-seed fast-check properties with 1,000 cases each
- isolated fresh/upgrade/backfill/rerun, separate up/down drift, failed rollback, and explicit
  privilege migration tests
- real PostgreSQL CRUD, cross-organization, stale-write, guard, and audit rollback tests
- allocation/parent and client/project races held behind a dedicated target-row lock until both
  backend chains are observed blocked and both promises are proven unsettled; release then permits
  one valid winner and one business rejection, with final invariants and no deadlock
- HTTP validation, CSRF, status, redaction, and five-role matrix tests
- local performance smoke: 100 people, 2,000 allocations, 52 weeks, threshold 1.5 seconds

This is the only supported performance claim. Larger datasets and planner UI responsiveness have not
been validated.

## Remaining Deferrals

- leave and holiday management UI
- catalog and planning-settings administration UI
- CSV import/export
- leave balances, approvals, and sensitive reasons
- automatic staffing or assignment
- broader non-capacity business conflict types
- financial forecasting
