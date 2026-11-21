CREATE TABLE product_catalog (
  product_line_id TEXT PRIMARY KEY NOT NULL,
  product_line TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  official_url TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE product_capability (
  capability_id TEXT PRIMARY KEY NOT NULL,
  product_line_id TEXT NOT NULL REFERENCES product_catalog(product_line_id),
  capability_name TEXT NOT NULL,
  problem_addressed TEXT NOT NULL,
  official_url TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE cs_product_use_case (
  use_case_id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  buying_group_id TEXT NOT NULL,
  deployment_id TEXT,
  capability_id TEXT NOT NULL REFERENCES product_capability(capability_id),
  stage TEXT NOT NULL CHECK(stage IN ('deployed','proposed')),
  use_case_name TEXT NOT NULL,
  customer_problem TEXT NOT NULL,
  supported_workflow TEXT NOT NULL,
  adoption_definition TEXT NOT NULL,
  success_measure TEXT NOT NULL,
  UNIQUE(account_id, use_case_id),
  CHECK((stage = 'deployed') = (deployment_id IS NOT NULL)),
  FOREIGN KEY(account_id, buying_group_id) REFERENCES buying_group(account_id, buying_group_id),
  FOREIGN KEY(account_id, deployment_id) REFERENCES product_deployment(account_id, deployment_id)
);
--> statement-breakpoint
CREATE TABLE cs_event_observation (
  observation_id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  use_case_id TEXT NOT NULL,
  observation_kind TEXT NOT NULL,
  evidence_role TEXT NOT NULL CHECK(evidence_role IN ('qualifying_evidence','operational_evidence','customer_statement',
    'csm_context','evaluation_context','reference_context','passive_engagement','market_context')),
  observed_text TEXT NOT NULL CHECK(length(trim(observed_text)) > 0),
  source_part TEXT NOT NULL CHECK(source_part IN ('body','summary','email_message')),
  source_message_id TEXT REFERENCES email_message(message_id),
  qualification_signal_id TEXT UNIQUE REFERENCES qualification_signal(signal_id),
  CHECK((source_part = 'email_message') = (source_message_id IS NOT NULL)),
  FOREIGN KEY(account_id, event_id) REFERENCES engagement_event(account_id, event_id),
  FOREIGN KEY(account_id, use_case_id) REFERENCES cs_product_use_case(account_id, use_case_id)
);
--> statement-breakpoint
CREATE INDEX cs_event_observation_event ON cs_event_observation(event_id, use_case_id);
--> statement-breakpoint
CREATE TABLE cs_workstream_use_case (
  workstream_id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  use_case_id TEXT NOT NULL,
  FOREIGN KEY(account_id, workstream_id) REFERENCES cs_workstream(account_id, workstream_id),
  FOREIGN KEY(account_id, use_case_id) REFERENCES cs_product_use_case(account_id, use_case_id)
);
--> statement-breakpoint
CREATE VIEW v_product_use_cases AS
SELECT u.*, g.name AS buying_group, c.capability_name, c.problem_addressed,
       p.product_line_id, p.product_line, p.official_url AS product_reference_url,
       c.official_url AS capability_reference_url
FROM cs_product_use_case u
JOIN buying_group g USING(buying_group_id)
JOIN product_capability c USING(capability_id)
JOIN product_catalog p USING(product_line_id);
--> statement-breakpoint
CREATE VIEW v_event_observations AS
SELECT o.*, e.source_id, e.source_kind, e.source_record_ref,
       coalesce(m.sent_at, e.occurred_at) AS observed_at,
       m.sender_id, sender.full_name AS source_sender,
       CASE o.source_part WHEN 'email_message' THEN m.body WHEN 'body' THEN raw.body ELSE e.summary END AS source_text,
       u.buying_group_id, u.buying_group, u.product_line, u.capability_name, u.use_case_name,
       u.customer_problem, u.capability_reference_url
FROM cs_event_observation o
JOIN v_engagement_timeline e USING(event_id)
JOIN engagement_event raw USING(event_id)
JOIN v_product_use_cases u USING(use_case_id)
LEFT JOIN email_message m ON m.message_id = o.source_message_id AND m.event_id = o.event_id
LEFT JOIN person sender ON sender.person_id = m.sender_id
WHERE o.source_part <> 'email_message' OR (m.message_id IS NOT NULL AND
  julianday(m.sent_at) <= (SELECT julianday(as_of_utc) FROM dataset_version));
