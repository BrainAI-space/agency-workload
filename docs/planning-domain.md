# Planning Domain Core

**Status:** Verified core boundary. Planner UI integration is deferred.

This milestone establishes deterministic calendar math, the complete V1 planning schema, and the
core settings, people, project, allocation, and schedule APIs. Catalog administration, leave APIs,
holiday APIs, clients, conflict acknowledgement, earliest-start HTTP, and forecast HTTP are
deliberately deferred rather than exposed without complete authorization and integration coverage.

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
capacity, confirmed minutes, and tentative minutes.

## Earliest Start

The pure engine filters by delivery role, team, and required tags. It searches from `notBefore` for
the requested workday count and daily available minutes under the confirmed or confirmed-plus-
tentative scenario. Weekends, holidays, and leave extend the completion date. A calendar gap longer
than seven days breaks the sequence. Search is explicitly bounded to 1-730 calendar days.

The engine is available for the future HTTP endpoint, but no earliest-start API is claimed in this
boundary.

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

## Core HTTP Boundary

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

Member self-service leave is deferred until the leave API and its own-detail authorization matrix are
implemented. The nullable `memberships.linked_person_id` schema support is present, but no partially
protected leave endpoint is exposed.

## Verification And Supported Dataset

- 22 named golden cases derived from the supplied milestone rules
- two fixed-seed fast-check properties with 1,000 cases each
- isolated fresh/up/rerun/checksum/rollback/grant migration tests
- real PostgreSQL CRUD, concurrency, cross-organization, stale-write, guard, and audit rollback tests
- HTTP validation, CSRF, status, and five-role matrix tests
- local performance smoke: 100 people, 2,000 allocations, 52 weeks, threshold 1.5 seconds

This is the only supported performance claim. Larger datasets and planner UI responsiveness have not
been validated.
