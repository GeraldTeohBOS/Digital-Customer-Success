CREATE TABLE cs_workstream (
  workstream_id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES account(account_id),
  buying_group_id TEXT,
  job_kind TEXT NOT NULL CHECK(job_kind IN ('first_value','rollout','renewal','risk','expansion')),
  title TEXT NOT NULL,
  customer_objective TEXT NOT NULL,
  case_id TEXT,
  evidence_event_id TEXT,
  UNIQUE(account_id, workstream_id),
  UNIQUE(account_id, workstream_id, job_kind),
  FOREIGN KEY(account_id, buying_group_id) REFERENCES buying_group(account_id, buying_group_id),
  FOREIGN KEY(account_id, evidence_event_id) REFERENCES engagement_event(account_id, event_id)
);

CREATE TABLE cs_action (
  action_id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES person(person_id),
  customer_contact_id TEXT,
  title TEXT NOT NULL CHECK(length(trim(title)) > 0),
  due_on TEXT NOT NULL,
  parent_action_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(account_id, action_id),
  FOREIGN KEY(account_id, workstream_id) REFERENCES cs_workstream(account_id, workstream_id),
  FOREIGN KEY(account_id, customer_contact_id) REFERENCES person(account_id, person_id),
  FOREIGN KEY(account_id, parent_action_id) REFERENCES cs_action(account_id, action_id)
);

CREATE TABLE cs_action_update (
  action_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  status TEXT NOT NULL CHECK(status IN ('open','in_progress','blocked','completed')),
  due_on TEXT NOT NULL,
  note TEXT NOT NULL CHECK(length(trim(note)) > 0),
  evidence_event_id TEXT,
  follow_up_title TEXT,
  follow_up_on TEXT,
  follow_up_action_id TEXT UNIQUE,
  actor_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  intent_json TEXT NOT NULL CHECK(json_valid(intent_json)),
  CHECK((follow_up_title IS NULL) = (follow_up_on IS NULL)),
  CHECK((follow_up_action_id IS NULL) = (follow_up_on IS NULL)),
  CHECK(follow_up_on IS NULL OR status = 'completed'),
  PRIMARY KEY(action_id, revision),
  FOREIGN KEY(account_id, action_id) REFERENCES cs_action(account_id, action_id),
  FOREIGN KEY(account_id, evidence_event_id) REFERENCES engagement_event(account_id, event_id)
);

CREATE TRIGGER spawn_cs_follow_up
AFTER INSERT ON cs_action_update WHEN NEW.follow_up_on IS NOT NULL
BEGIN
  INSERT INTO cs_action(action_id,account_id,workstream_id,owner_id,customer_contact_id,title,due_on,parent_action_id,created_at)
  SELECT NEW.follow_up_action_id,
         a.account_id,a.workstream_id,a.owner_id,a.customer_contact_id,NEW.follow_up_title,NEW.follow_up_on,a.action_id,NEW.recorded_at
  FROM cs_action a WHERE a.action_id = NEW.action_id;
END;

CREATE INDEX cs_action_scope ON cs_action(account_id, workstream_id);

CREATE VIEW v_customer_action_history AS
SELECT action_id, account_id, revision, status, due_on, note, evidence_event_id,
       follow_up_title, follow_up_on, follow_up_action_id, recorded_at
FROM cs_action_update;

CREATE VIEW v_customer_action_queue AS
WITH latest AS (
  SELECT *, row_number() OVER (PARTITION BY action_id ORDER BY revision DESC) AS position
  FROM cs_action_update
)
SELECT a.action_id, a.account_id, company.account_name, w.job_kind,
       a.workstream_id, w.title AS workstream_title, w.customer_objective,
       a.title, a.owner_id, owner.full_name AS owner_name, a.customer_contact_id,
       contact.full_name AS customer_contact, w.buying_group_id, w.case_id,
       coalesce(u.status,'open') AS status, coalesce(u.revision,0) AS revision,
       coalesce(u.due_on,a.due_on) AS due_on, a.due_on AS original_due_on,
       w.evidence_event_id AS source_event_id, u.evidence_event_id AS update_evidence_event_id,
       u.note AS latest_note, CASE WHEN u.status='completed' THEN u.note END AS outcome,
       u.recorded_at AS updated_at,
       u.follow_up_title, u.follow_up_on, u.follow_up_action_id, a.parent_action_id, a.created_at
FROM cs_action a
JOIN account company ON company.account_id = a.account_id
JOIN cs_workstream w ON w.workstream_id = a.workstream_id
JOIN person owner ON owner.person_id = a.owner_id
LEFT JOIN person contact ON contact.person_id = a.customer_contact_id
LEFT JOIN latest u ON u.action_id = a.action_id AND u.position = 1;
