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
];
