export interface SqlMigration {
  id: string;
  up: string;
  down: string;
}

const up = String.raw`
CREATE TABLE {{schema}}.organizations (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE {{schema}}.users (
  id uuid PRIMARY KEY,
  gotrue_user_id uuid NOT NULL UNIQUE,
  email text NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254 AND email !~ '[\\r\\n]'),
  display_name text CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 120),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE {{schema}}.memberships (
  organization_id uuid NOT NULL REFERENCES {{schema}}.organizations(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES {{schema}}.users(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'planner', 'member', 'viewer')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX memberships_user_active_idx ON {{schema}}.memberships(user_id, active);
CREATE INDEX memberships_org_role_active_idx ON {{schema}}.memberships(organization_id, role, active);

CREATE TABLE {{schema}}.invitations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES {{schema}}.organizations(id) ON DELETE RESTRICT,
  email text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254 AND email !~ '[\\r\\n]'),
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'planner', 'member', 'viewer')),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  invited_by uuid NOT NULL REFERENCES {{schema}}.users(id) ON DELETE RESTRICT,
  accepted_by uuid REFERENCES {{schema}}.users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'accepted') = (accepted_at IS NOT NULL AND accepted_by IS NOT NULL))
);
CREATE UNIQUE INDEX invitations_org_pending_email_idx ON {{schema}}.invitations(organization_id, lower(email)) WHERE status = 'pending';
CREATE INDEX invitations_email_status_idx ON {{schema}}.invitations(lower(email), status, expires_at);

CREATE TABLE {{schema}}.sessions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES {{schema}}.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES {{schema}}.users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  csrf_hash bytea NOT NULL UNIQUE CHECK (octet_length(csrf_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (idle_expires_at <= absolute_expires_at)
);
CREATE INDEX sessions_user_active_idx ON {{schema}}.sessions(user_id, revoked_at, absolute_expires_at);
CREATE INDEX sessions_org_active_idx ON {{schema}}.sessions(organization_id, revoked_at);

CREATE TABLE {{schema}}.auth_requests (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES {{schema}}.organizations(id) ON DELETE CASCADE,
  email_hash bytea NOT NULL CHECK (octet_length(email_hash) = 32),
  ip_hash bytea NOT NULL CHECK (octet_length(ip_hash) = 32),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  sent_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_requests_email_rate_idx ON {{schema}}.auth_requests(email_hash, sent_at DESC);
CREATE INDEX auth_requests_ip_rate_idx ON {{schema}}.auth_requests(ip_hash, sent_at DESC);

CREATE TABLE {{schema}}.audit_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES {{schema}}.organizations(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES {{schema}}.users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  target_type text NOT NULL CHECK (length(target_type) BETWEEN 1 AND 50),
  target_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_org_created_idx ON {{schema}}.audit_events(organization_id, created_at DESC, id DESC);

CREATE FUNCTION {{schema}}.prevent_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit events are append-only';
END;
$$;
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON {{schema}}.audit_events
FOR EACH ROW EXECUTE FUNCTION {{schema}}.prevent_audit_mutation();

GRANT USAGE ON SCHEMA {{schema}} TO agency_workload_runtime, agency_workload_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA {{schema}} TO agency_workload_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA {{schema}} TO agency_workload_backup;
REVOKE ALL ON {{schema}}.schema_migrations FROM agency_workload_runtime, agency_workload_backup;
REVOKE UPDATE, DELETE ON {{schema}}.audit_events FROM agency_workload_runtime;
`;

const down = `
DROP TABLE IF EXISTS {{schema}}.audit_events CASCADE;
DROP FUNCTION IF EXISTS {{schema}}.prevent_audit_mutation();
DROP TABLE IF EXISTS {{schema}}.auth_requests CASCADE;
DROP TABLE IF EXISTS {{schema}}.sessions CASCADE;
DROP TABLE IF EXISTS {{schema}}.invitations CASCADE;
DROP TABLE IF EXISTS {{schema}}.memberships CASCADE;
DROP TABLE IF EXISTS {{schema}}.users CASCADE;
DROP TABLE IF EXISTS {{schema}}.organizations CASCADE;
`;

export const migrations: readonly SqlMigration[] = [
  { id: "0001_identity_sessions_admin", up, down },
  {
    id: "0002_email_control_character_checks",
    up: `
ALTER TABLE {{schema}}.users DROP CONSTRAINT users_email_check;
ALTER TABLE {{schema}}.users ADD CONSTRAINT users_email_check CHECK (
  email = lower(email) AND length(email) BETWEEN 3 AND 254
  AND position(chr(10) in email) = 0 AND position(chr(13) in email) = 0
);
ALTER TABLE {{schema}}.invitations DROP CONSTRAINT invitations_email_check;
ALTER TABLE {{schema}}.invitations ADD CONSTRAINT invitations_email_check CHECK (
  email = lower(email) AND length(email) BETWEEN 3 AND 254
  AND position(chr(10) in email) = 0 AND position(chr(13) in email) = 0
);`,
    down: `
ALTER TABLE {{schema}}.users DROP CONSTRAINT users_email_check;
ALTER TABLE {{schema}}.users ADD CONSTRAINT users_email_check CHECK (
  email = lower(email) AND length(email) BETWEEN 3 AND 254
);
ALTER TABLE {{schema}}.invitations DROP CONSTRAINT invitations_email_check;
ALTER TABLE {{schema}}.invitations ADD CONSTRAINT invitations_email_check CHECK (
  email = lower(email) AND length(email) BETWEEN 3 AND 254
);`,
  },
  {
    id: "0003_single_organization_and_invitation_delivery",
    up: `
ALTER TABLE {{schema}}.invitations
  ADD COLUMN delivery_status text NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending', 'sent', 'failed')),
  ADD COLUMN delivery_attempts integer NOT NULL DEFAULT 0
    CHECK (delivery_attempts BETWEEN 0 AND 20),
  ADD COLUMN last_delivery_at timestamptz,
  ADD COLUMN delivery_error_at timestamptz;

DO $$
BEGIN
  IF EXISTS (
    SELECT user_id FROM {{schema}}.memberships
    WHERE active GROUP BY user_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'single-organization invariant conflict: user has multiple active memberships';
  END IF;
  IF EXISTS (
    SELECT lower(email) FROM {{schema}}.invitations
    WHERE status = 'pending' GROUP BY lower(email) HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'single-organization invariant conflict: email has multiple pending invitations';
  END IF;
END;
$$;

DROP INDEX {{schema}}.invitations_org_pending_email_idx;
CREATE UNIQUE INDEX memberships_one_active_user_idx
  ON {{schema}}.memberships(user_id) WHERE active;
CREATE UNIQUE INDEX invitations_one_pending_email_idx
  ON {{schema}}.invitations(lower(email)) WHERE status = 'pending';`,
    down: `
DROP INDEX IF EXISTS {{schema}}.invitations_one_pending_email_idx;
DROP INDEX IF EXISTS {{schema}}.memberships_one_active_user_idx;
CREATE UNIQUE INDEX invitations_org_pending_email_idx
  ON {{schema}}.invitations(organization_id, lower(email)) WHERE status = 'pending';
ALTER TABLE {{schema}}.invitations
  DROP COLUMN delivery_error_at,
  DROP COLUMN last_delivery_at,
  DROP COLUMN delivery_attempts,
  DROP COLUMN delivery_status;`,
  },
  {
    id: "0004_planning_domain_core",
    up: `
CREATE TABLE {{schema}}.organization_planning_settings (
  organization_id uuid PRIMARY KEY REFERENCES {{schema}}.organizations(id) ON DELETE CASCADE,
  timezone text NOT NULL DEFAULT 'UTC' CHECK (length(timezone) BETWEEN 1 AND 100),
  week_starts_on smallint NOT NULL DEFAULT 1 CHECK (week_starts_on BETWEEN 1 AND 7),
  date_format text NOT NULL DEFAULT 'DD MMM YYYY' CHECK (date_format IN ('DD MMM YYYY', 'MMM D, YYYY', 'YYYY-MM-DD')),
  forecast_horizon_weeks smallint NOT NULL DEFAULT 13 CHECK (forecast_horizon_weeks BETWEEN 1 AND 104),
  billable_target_percent smallint NOT NULL DEFAULT 75 CHECK (billable_target_percent BETWEEN 0 AND 100),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE {{schema}}.teams (
  organization_id uuid NOT NULL REFERENCES {{schema}}.organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id)
);
CREATE UNIQUE INDEX teams_active_name_idx ON {{schema}}.teams(organization_id, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE {{schema}}.delivery_roles (
  organization_id uuid NOT NULL REFERENCES {{schema}}.organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id)
);
CREATE UNIQUE INDEX delivery_roles_active_name_idx ON {{schema}}.delivery_roles(organization_id, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE {{schema}}.tags (
  organization_id uuid NOT NULL REFERENCES {{schema}}.organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id)
);
CREATE UNIQUE INDEX tags_active_name_idx ON {{schema}}.tags(organization_id, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE {{schema}}.people (
  organization_id uuid NOT NULL REFERENCES {{schema}}.organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  email text CHECK (email IS NULL OR (email = lower(email) AND length(email) BETWEEN 3 AND 254)),
  team_id uuid,
  delivery_role_id uuid,
  active_from date NOT NULL,
  active_until date,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, team_id) REFERENCES {{schema}}.teams(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, delivery_role_id) REFERENCES {{schema}}.delivery_roles(organization_id, id) ON DELETE RESTRICT,
  CHECK (active_until IS NULL OR active_until >= active_from)
);
CREATE UNIQUE INDEX people_active_email_idx ON {{schema}}.people(organization_id, email) WHERE email IS NOT NULL AND archived_at IS NULL;
CREATE INDEX people_active_range_idx ON {{schema}}.people(organization_id, active_from, active_until) WHERE archived_at IS NULL;

ALTER TABLE {{schema}}.memberships ADD COLUMN linked_person_id uuid;
ALTER TABLE {{schema}}.memberships ADD CONSTRAINT memberships_linked_person_fk
  FOREIGN KEY (organization_id, linked_person_id) REFERENCES {{schema}}.people(organization_id, id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX memberships_linked_person_idx ON {{schema}}.memberships(organization_id, linked_person_id) WHERE linked_person_id IS NOT NULL AND active;

CREATE TABLE {{schema}}.person_tags (
  organization_id uuid NOT NULL,
  person_id uuid NOT NULL,
  tag_id uuid NOT NULL,
  PRIMARY KEY (organization_id, person_id, tag_id),
  FOREIGN KEY (organization_id, person_id) REFERENCES {{schema}}.people(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, tag_id) REFERENCES {{schema}}.tags(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE {{schema}}.work_schedule_versions (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  person_id uuid NOT NULL,
  effective_from date NOT NULL,
  effective_until date,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, person_id, effective_from),
  FOREIGN KEY (organization_id, person_id) REFERENCES {{schema}}.people(organization_id, id) ON DELETE CASCADE,
  CHECK (effective_until IS NULL OR effective_until >= effective_from)
);
CREATE INDEX work_schedule_person_period_idx ON {{schema}}.work_schedule_versions(organization_id, person_id, effective_from, effective_until);

CREATE FUNCTION {{schema}}.prevent_schedule_overlap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW.organization_id::text || ':' || NEW.person_id::text));
  IF EXISTS (
    SELECT 1 FROM {{schema}}.work_schedule_versions existing
    WHERE existing.organization_id = NEW.organization_id
      AND existing.person_id = NEW.person_id
      AND existing.id <> NEW.id
      AND daterange(existing.effective_from, existing.effective_until, '[]') &&
          daterange(NEW.effective_from, NEW.effective_until, '[]')
  ) THEN
    RAISE EXCEPTION 'work schedule effective periods overlap';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER work_schedule_no_overlap
BEFORE INSERT OR UPDATE ON {{schema}}.work_schedule_versions
FOR EACH ROW EXECUTE FUNCTION {{schema}}.prevent_schedule_overlap();

CREATE TABLE {{schema}}.work_schedule_weekdays (
  organization_id uuid NOT NULL,
  schedule_version_id uuid NOT NULL,
  iso_weekday smallint NOT NULL CHECK (iso_weekday BETWEEN 1 AND 7),
  minutes integer NOT NULL CHECK (minutes BETWEEN 0 AND 1440),
  PRIMARY KEY (organization_id, schedule_version_id, iso_weekday),
  FOREIGN KEY (organization_id, schedule_version_id) REFERENCES {{schema}}.work_schedule_versions(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE {{schema}}.holiday_calendars (
  organization_id uuid NOT NULL REFERENCES {{schema}}.organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  archived_at timestamptz,
  PRIMARY KEY (organization_id, id)
);
CREATE TABLE {{schema}}.holiday_dates (
  organization_id uuid NOT NULL,
  calendar_id uuid NOT NULL,
  holiday_date date NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  PRIMARY KEY (organization_id, calendar_id, holiday_date),
  FOREIGN KEY (organization_id, calendar_id) REFERENCES {{schema}}.holiday_calendars(organization_id, id) ON DELETE CASCADE
);
CREATE TABLE {{schema}}.person_holiday_calendars (
  organization_id uuid NOT NULL,
  person_id uuid NOT NULL,
  calendar_id uuid NOT NULL,
  PRIMARY KEY (organization_id, person_id, calendar_id),
  FOREIGN KEY (organization_id, person_id) REFERENCES {{schema}}.people(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, calendar_id) REFERENCES {{schema}}.holiday_calendars(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE {{schema}}.leave_types (
  organization_id uuid NOT NULL REFERENCES {{schema}}.organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  archived_at timestamptz,
  PRIMARY KEY (organization_id, id)
);
CREATE UNIQUE INDEX leave_types_active_name_idx ON {{schema}}.leave_types(organization_id, lower(name)) WHERE archived_at IS NULL;
CREATE TABLE {{schema}}.leave_entries (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  person_id uuid NOT NULL,
  leave_type_id uuid NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  minutes_per_day integer CHECK (minutes_per_day BETWEEN 1 AND 1440),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, person_id) REFERENCES {{schema}}.people(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, leave_type_id) REFERENCES {{schema}}.leave_types(organization_id, id) ON DELETE RESTRICT,
  CHECK (end_date >= start_date)
);
CREATE INDEX leave_entries_person_dates_idx ON {{schema}}.leave_entries(organization_id, person_id, start_date, end_date) WHERE deleted_at IS NULL;

CREATE TABLE {{schema}}.clients (
  organization_id uuid NOT NULL REFERENCES {{schema}}.organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  archived_at timestamptz,
  PRIMARY KEY (organization_id, id)
);
CREATE UNIQUE INDEX clients_active_name_idx ON {{schema}}.clients(organization_id, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE {{schema}}.projects (
  organization_id uuid NOT NULL REFERENCES {{schema}}.organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  client_id uuid,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  kind text NOT NULL CHECK (kind IN ('billable', 'internal')),
  status text NOT NULL CHECK (status IN ('draft', 'tentative', 'confirmed', 'completed')),
  target_start date,
  target_end date,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  completed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, client_id) REFERENCES {{schema}}.clients(organization_id, id) ON DELETE RESTRICT,
  CHECK (target_end IS NULL OR target_start IS NULL OR target_end >= target_start),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);
CREATE INDEX projects_status_idx ON {{schema}}.projects(organization_id, status) WHERE archived_at IS NULL;

CREATE TABLE {{schema}}.allocations (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  person_id uuid NOT NULL,
  project_id uuid NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  mode text NOT NULL CHECK (mode IN ('minutes_per_day', 'capacity_percent')),
  minutes_per_day integer,
  capacity_percent integer,
  allocation_state text NOT NULL CHECK (allocation_state IN ('confirmed', 'tentative')),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, person_id) REFERENCES {{schema}}.people(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, project_id) REFERENCES {{schema}}.projects(organization_id, id) ON DELETE RESTRICT,
  CHECK (end_date >= start_date),
  CHECK (
    (mode = 'minutes_per_day' AND minutes_per_day BETWEEN 1 AND 1440 AND capacity_percent IS NULL) OR
    (mode = 'capacity_percent' AND capacity_percent BETWEEN 1 AND 1000 AND minutes_per_day IS NULL)
  )
);
CREATE INDEX allocations_person_dates_idx ON {{schema}}.allocations(organization_id, person_id, start_date, end_date) WHERE deleted_at IS NULL;
CREATE INDEX allocations_project_dates_idx ON {{schema}}.allocations(organization_id, project_id, start_date, end_date) WHERE deleted_at IS NULL;

CREATE TABLE {{schema}}.conflict_acknowledgements (
  organization_id uuid NOT NULL REFERENCES {{schema}}.organizations(id) ON DELETE CASCADE,
  fingerprint text NOT NULL CHECK (length(fingerprint) BETWEEN 8 AND 128),
  acknowledged_by uuid NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, fingerprint),
  FOREIGN KEY (acknowledged_by) REFERENCES {{schema}}.users(id) ON DELETE RESTRICT
);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA {{schema}} TO agency_workload_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA {{schema}} TO agency_workload_backup;
REVOKE ALL ON {{schema}}.schema_migrations FROM agency_workload_runtime, agency_workload_backup;
REVOKE UPDATE, DELETE ON {{schema}}.audit_events FROM agency_workload_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE agency_workload_migrator IN SCHEMA {{schema}}
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agency_workload_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE agency_workload_migrator IN SCHEMA {{schema}}
  GRANT SELECT ON TABLES TO agency_workload_backup;`,
    down: `
DROP TABLE IF EXISTS {{schema}}.conflict_acknowledgements CASCADE;
DROP TABLE IF EXISTS {{schema}}.allocations CASCADE;
DROP TABLE IF EXISTS {{schema}}.projects CASCADE;
DROP TABLE IF EXISTS {{schema}}.clients CASCADE;
DROP TABLE IF EXISTS {{schema}}.leave_entries CASCADE;
DROP TABLE IF EXISTS {{schema}}.leave_types CASCADE;
DROP TABLE IF EXISTS {{schema}}.person_holiday_calendars CASCADE;
DROP TABLE IF EXISTS {{schema}}.holiday_dates CASCADE;
DROP TABLE IF EXISTS {{schema}}.holiday_calendars CASCADE;
DROP TABLE IF EXISTS {{schema}}.work_schedule_weekdays CASCADE;
DROP TABLE IF EXISTS {{schema}}.work_schedule_versions CASCADE;
DROP FUNCTION IF EXISTS {{schema}}.prevent_schedule_overlap();
DROP TABLE IF EXISTS {{schema}}.person_tags CASCADE;
ALTER TABLE {{schema}}.memberships DROP CONSTRAINT IF EXISTS memberships_linked_person_fk;
DROP INDEX IF EXISTS {{schema}}.memberships_linked_person_idx;
ALTER TABLE {{schema}}.memberships DROP COLUMN IF EXISTS linked_person_id;
DROP TABLE IF EXISTS {{schema}}.people CASCADE;
DROP TABLE IF EXISTS {{schema}}.tags CASCADE;
DROP TABLE IF EXISTS {{schema}}.delivery_roles CASCADE;
DROP TABLE IF EXISTS {{schema}}.teams CASCADE;
DROP TABLE IF EXISTS {{schema}}.organization_planning_settings CASCADE;`,
  },
  {
    id: "0005_project_states_dates_and_timezones",
    up: `
ALTER TABLE {{schema}}.projects DROP CONSTRAINT projects_status_check;
ALTER TABLE {{schema}}.projects ADD CONSTRAINT projects_status_check
  CHECK (status IN ('draft', 'tentative', 'confirmed', 'completed', 'cancelled'));
ALTER TABLE {{schema}}.projects ADD CONSTRAINT projects_target_start_required_check
  CHECK (target_end IS NULL OR target_start IS NOT NULL);
ALTER TABLE {{schema}}.organization_planning_settings ADD CONSTRAINT planning_timezone_shape_check
  CHECK (timezone = 'UTC' OR timezone ~ '^[A-Za-z_]+/[A-Za-z0-9_+.-]+(?:/[A-Za-z0-9_+.-]+)*$');`,
    down: `
ALTER TABLE {{schema}}.organization_planning_settings DROP CONSTRAINT planning_timezone_shape_check;
ALTER TABLE {{schema}}.projects DROP CONSTRAINT projects_target_start_required_check;
ALTER TABLE {{schema}}.projects DROP CONSTRAINT projects_status_check;
ALTER TABLE {{schema}}.projects ADD CONSTRAINT projects_status_check
  CHECK (status IN ('draft', 'tentative', 'confirmed', 'completed'));`,
  },
];
