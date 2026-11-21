CREATE SCHEMA IF NOT EXISTS cs_pilot;

CREATE TABLE IF NOT EXISTS cs_pilot.account (
  account_id text PRIMARY KEY CHECK (account_id ~ '^[a-zA-Z0-9]+$'),
  account_name text NOT NULL,
  source_modified_at timestamptz NOT NULL,
  synced_at timestamptz NOT NULL,
  active boolean NOT NULL
);

CREATE TABLE IF NOT EXISTS cs_pilot.contact (
  account_id text NOT NULL REFERENCES cs_pilot.account,
  person_id text NOT NULL CHECK (person_id ~ '^[a-zA-Z0-9]+$'),
  full_name text NOT NULL,
  job_title text,
  source_modified_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, person_id)
);

CREATE TABLE IF NOT EXISTS cs_pilot.engagement_event (
  event_id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES cs_pilot.account,
  person_id text,
  event_kind text NOT NULL CHECK (event_kind IN ('account_updated','contact_added','contact_updated','contact_removed')),
  title text NOT NULL,
  summary text NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS pilot_event_account ON cs_pilot.engagement_event (account_id, occurred_at DESC, event_id);

CREATE TABLE IF NOT EXISTS cs_pilot.account_access (
  user_id text NOT NULL,
  account_id text NOT NULL REFERENCES cs_pilot.account,
  PRIMARY KEY (user_id, account_id)
);

CREATE TABLE IF NOT EXISTS cs_pilot.login_attempt (
  token_hash text PRIMARY KEY,
  state text NOT NULL,
  nonce text NOT NULL,
  verifier text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS cs_pilot.web_session (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS cs_pilot.outreach_draft (
  draft_id uuid PRIMARY KEY,
  account_id text NOT NULL REFERENCES cs_pilot.account,
  person_id text NOT NULL,
  recipient_name text NOT NULL,
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 240),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by text NOT NULL,
  edited_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  UNIQUE (draft_id, revision)
);
CREATE INDEX IF NOT EXISTS pilot_outreach_account ON cs_pilot.outreach_draft (account_id, edited_at DESC);

CREATE TABLE IF NOT EXISTS cs_pilot.gong_handoff (
  draft_id uuid PRIMARY KEY,
  approved_revision integer NOT NULL,
  delivery_mode text NOT NULL CHECK (delivery_mode IN ('simulated','live')),
  person_id text NOT NULL,
  flow_id text NOT NULL,
  owner_email text NOT NULL,
  status text NOT NULL CHECK (status IN ('processing','queued','rejected','review_required')),
  flow_instance_id text,
  request_id text,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK ((status = 'queued') = (flow_instance_id IS NOT NULL)),
  CHECK ((status = 'processing') = (finished_at IS NULL)),
  FOREIGN KEY (draft_id, approved_revision) REFERENCES cs_pilot.outreach_draft(draft_id,revision)
);

CREATE UNIQUE INDEX IF NOT EXISTS pilot_one_live_gong_task ON cs_pilot.gong_handoff (flow_id, person_id)
WHERE delivery_mode = 'live' AND status IN ('processing','queued','review_required');

CREATE TABLE IF NOT EXISTS cs_pilot.account_role_grant (
  account_id text NOT NULL REFERENCES cs_pilot.account,
  user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('viewer','csm','approver','gong_operator','access_admin')),
  granted_by text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id,user_id,role)
);
CREATE INDEX IF NOT EXISTS pilot_roles_by_user ON cs_pilot.account_role_grant (user_id,role,account_id);

CREATE TABLE IF NOT EXISTS cs_pilot.authorization_audit (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id text NOT NULL REFERENCES cs_pilot.account,
  actor_id text NOT NULL,
  action text NOT NULL,
  target_user_id text,
  target_role text,
  draft_id uuid REFERENCES cs_pilot.outreach_draft,
  revision integer,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pilot_audit_by_account ON cs_pilot.authorization_audit (account_id,recorded_at DESC,audit_id DESC);
ALTER TABLE cs_pilot.outreach_draft ADD COLUMN IF NOT EXISTS approved_by text
  CHECK (approved_by IS NULL OR (approved_at IS NOT NULL AND approved_by<>created_by));

CREATE TABLE IF NOT EXISTS cs_pilot.migration_history (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

WITH first_run AS (
  INSERT INTO cs_pilot.migration_history (name) VALUES ('account-scoped-rbac-v1')
  ON CONFLICT DO NOTHING RETURNING name
), migrated AS (
  INSERT INTO cs_pilot.account_role_grant (account_id,user_id,role,granted_by)
  SELECT a.account_id,a.user_id,'viewer','system:migration' FROM cs_pilot.account_access a CROSS JOIN first_run
  ON CONFLICT DO NOTHING RETURNING account_id,user_id,role
)
INSERT INTO cs_pilot.authorization_audit (account_id,actor_id,action,target_user_id,target_role)
SELECT account_id,'system:migration','role.grant',user_id,role FROM migrated;
