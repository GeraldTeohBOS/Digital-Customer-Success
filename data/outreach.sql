CREATE TABLE cs_outreach_draft (
  draft_id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  buying_group_id TEXT NOT NULL,
  workstream_id TEXT,
  case_id TEXT,
  prospect_id TEXT NOT NULL,
  prospect_name TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  recipient_name TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  recipient_person_id TEXT,
  sender_id TEXT NOT NULL REFERENCES person(person_id),
  route TEXT NOT NULL CHECK(route IN ('direct_follow_up','warm_intro')),
  generated_subject TEXT NOT NULL,
  generated_body TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL,
  why_now TEXT,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(account_id, buying_group_id) REFERENCES cs_expansion_target(account_id, buying_group_id),
  FOREIGN KEY(account_id, workstream_id) REFERENCES cs_workstream(account_id, workstream_id),
  FOREIGN KEY(account_id, recipient_person_id) REFERENCES person(account_id, person_id)
);

CREATE INDEX outreach_by_scope ON cs_outreach_draft(account_id, buying_group_id, prospect_id, created_at DESC);

CREATE TABLE cs_outreach_revision (
  draft_id TEXT NOT NULL REFERENCES cs_outreach_draft(draft_id),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  subject TEXT NOT NULL CHECK(length(trim(subject)) > 0),
  body TEXT NOT NULL CHECK(length(trim(body)) > 0),
  detail_json TEXT NOT NULL CHECK(json_valid(detail_json)),
  actor_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  intent_json TEXT NOT NULL CHECK(json_valid(intent_json)),
  CHECK((operation = 'edit' AND status = 'draft') OR
        (operation = 'approve' AND status = 'approved') OR
        (operation = 'queue' AND status = 'queued') OR
        (operation = 'send' AND status = 'sent') OR
        (operation = 'reply' AND status = 'replied')),
  PRIMARY KEY(draft_id, revision)
);

CREATE UNIQUE INDEX one_gong_handoff_per_draft ON cs_outreach_revision(draft_id) WHERE operation = 'queue';
CREATE UNIQUE INDEX one_send_per_draft ON cs_outreach_revision(draft_id) WHERE operation = 'send';

CREATE VIEW v_outreach_draft_queue AS
SELECT d.*, a.account_name, g.name AS buying_group, p.full_name AS sender_name, p.email AS sender_email,
       coalesce(r.revision,0) AS revision, coalesce(r.status,'draft') AS status,
       coalesce(r.subject,d.generated_subject) AS subject, coalesce(r.body,d.generated_body) AS body,
       coalesce(r.recorded_at,d.created_at) AS updated_at,
       q.detail_json AS handoff_json
FROM cs_outreach_draft d JOIN account a USING(account_id)
JOIN buying_group g USING(buying_group_id) JOIN person p ON p.person_id = d.sender_id
LEFT JOIN cs_outreach_revision r ON r.draft_id = d.draft_id AND r.revision = (
  SELECT max(revision) FROM cs_outreach_revision WHERE draft_id = d.draft_id
)
LEFT JOIN cs_outreach_revision q ON q.draft_id = d.draft_id AND q.operation = 'queue';

CREATE VIEW v_outreach_timeline AS
SELECT d.draft_id || ':' || r.operation || ':' || r.revision AS event_id,
       d.account_id, r.recorded_at AS occurred_at, 'email' AS event_kind,
       CASE r.operation WHEN 'reply' THEN 'Re: ' || r.subject ELSE r.subject END AS title,
       CASE r.operation WHEN 'send' THEN d.sender_name || ' sent a simulated email to ' || d.recipient_name || '.'
                        ELSE 'Simulated reply from ' || d.recipient_name || '.' END AS summary,
       json_extract(d.handoff_json,'$.flow_instance_id') || ':' || r.revision AS source_record_ref,
       'gong_engage_demo' AS source_id, 'Gong Engage simulation' AS source_name, 'simulated' AS source_kind,
       d.draft_id, d.buying_group_id, d.recipient_person_id, d.prospect_id, d.recipient_id,
       d.recipient_name, d.recipient_email, d.sender_name, d.sender_email,
       r.operation, r.revision,
       CASE r.operation WHEN 'reply' THEN json_extract(r.detail_json,'$.reply_body') ELSE r.body END AS body
FROM cs_outreach_revision r JOIN v_outreach_draft_queue d USING(draft_id)
WHERE r.operation IN ('send','reply');
