CREATE TABLE cs_expansion_target (
  buying_group_id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  use_case_id TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  entity_domain TEXT NOT NULL,
  entity_relationship TEXT NOT NULL CHECK(entity_relationship IN ('business_unit','subsidiary')),
  incumbent_buying_group_id TEXT NOT NULL,
  introduction_owner_id TEXT NOT NULL,
  introduction_event_id TEXT NOT NULL,
  proposed_discussion TEXT NOT NULL,
  contract_question TEXT NOT NULL,
  UNIQUE(account_id, buying_group_id),
  CHECK(buying_group_id <> incumbent_buying_group_id),
  FOREIGN KEY(account_id, buying_group_id) REFERENCES buying_group(account_id, buying_group_id),
  FOREIGN KEY(account_id, incumbent_buying_group_id) REFERENCES buying_group(account_id, buying_group_id),
  FOREIGN KEY(account_id, use_case_id) REFERENCES cs_product_use_case(account_id, use_case_id),
  FOREIGN KEY(buying_group_id, introduction_owner_id) REFERENCES group_membership(buying_group_id, person_id),
  FOREIGN KEY(account_id, introduction_event_id) REFERENCES engagement_event(account_id, event_id)
);

CREATE TABLE sumble_org_signal (
  signal_id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  buying_group_id TEXT NOT NULL,
  signal_kind TEXT NOT NULL CHECK(signal_kind IN ('job_post','technology','initiative','subsidiary_relationship')),
  observed_at TEXT NOT NULL,
  title TEXT NOT NULL,
  source_excerpt TEXT NOT NULL,
  technologies_json TEXT NOT NULL CHECK(json_valid(technologies_json) AND json_type(technologies_json) = 'array'),
  relevance_hypothesis TEXT NOT NULL,
  source_url TEXT NOT NULL,
  provider_record_ref TEXT NOT NULL UNIQUE,
  UNIQUE(buying_group_id, signal_id),
  FOREIGN KEY(account_id, buying_group_id) REFERENCES cs_expansion_target(account_id, buying_group_id)
);

CREATE TABLE clay_person_enrichment (
  enrichment_id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  buying_group_id TEXT NOT NULL,
  name TEXT NOT NULL,
  job_title TEXT NOT NULL,
  reported_team TEXT NOT NULL,
  employer_domain TEXT NOT NULL,
  work_email TEXT COLLATE NOCASE,
  email_state TEXT NOT NULL CHECK(email_state IN ('simulated_validated','profile_only')),
  persona_hypothesis TEXT NOT NULL CHECK(persona_hypothesis IN ('technical_evaluator','implementation_owner','security_reviewer','potential_sponsor')),
  responsibility_basis TEXT NOT NULL,
  primary_signal_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  profile_url TEXT NOT NULL,
  provider_record_ref TEXT NOT NULL UNIQUE,
  UNIQUE(buying_group_id, work_email),
  CHECK((email_state = 'simulated_validated') = (work_email IS NOT NULL)),
  FOREIGN KEY(account_id, buying_group_id) REFERENCES cs_expansion_target(account_id, buying_group_id),
  FOREIGN KEY(buying_group_id, primary_signal_id) REFERENCES sumble_org_signal(buying_group_id, signal_id)
);

CREATE TABLE cs_marketing_lead (
  lead_id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  buying_group_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  work_email TEXT NOT NULL COLLATE NOCASE,
  marketing_record_ref TEXT NOT NULL UNIQUE,
  UNIQUE(account_id, buying_group_id, work_email),
  UNIQUE(account_id, buying_group_id, lead_id),
  FOREIGN KEY(account_id, buying_group_id) REFERENCES cs_expansion_target(account_id, buying_group_id)
);

CREATE TABLE event_marketing_lead (
  event_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  buying_group_id TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  PRIMARY KEY(event_id, lead_id),
  FOREIGN KEY(account_id, event_id) REFERENCES engagement_event(account_id, event_id),
  FOREIGN KEY(event_id, buying_group_id) REFERENCES event_buying_group(event_id, buying_group_id),
  FOREIGN KEY(account_id, buying_group_id, lead_id) REFERENCES cs_marketing_lead(account_id, buying_group_id, lead_id)
);

CREATE VIEW v_expansion_targets AS
SELECT t.*, a.account_name, g.name AS buying_group, incumbent.name AS incumbent_buying_group,
       u.product_line, u.capability_name, u.customer_problem, u.supported_workflow, u.success_measure,
       owner.full_name AS introduction_owner, a.csm_name,
       buyer.person_id AS economic_buyer_id, buyer.full_name AS economic_buyer,
       q.case_id, coalesce(q.stage,'research_only') AS discovery_stage
FROM cs_expansion_target t
JOIN v_account_portfolio a USING(account_id)
JOIN buying_group g ON g.buying_group_id = t.buying_group_id
JOIN buying_group incumbent ON incumbent.buying_group_id = t.incumbent_buying_group_id
JOIN v_product_use_cases u USING(use_case_id)
JOIN person owner ON owner.person_id = t.introduction_owner_id
LEFT JOIN v_buying_group_members buyer ON buyer.buying_group_id = t.buying_group_id AND buyer.is_economic_buyer = 1
LEFT JOIN v_work_queue q ON q.buying_group_id = t.buying_group_id AND q.playbook = 'expansion';

CREATE VIEW v_clay_candidate_match AS
WITH crm_by_email AS (
  SELECT account_id, lower(trim(email)) AS work_email, count(*) AS match_count,
         CASE WHEN count(*) = 1 THEN min(person_id) END AS person_id
  FROM person WHERE account_id IS NOT NULL
  GROUP BY account_id, lower(trim(email))
), matched AS (
  SELECT c.*, t.entity_name, t.entity_domain, t.buying_group, p.person_id AS crm_person_id, coalesce(p.match_count,0) AS crm_match_count,
         member.person_id AS group_member_id, lead.lead_id,
         julianday(v.as_of_utc) - julianday(c.observed_at) AS age_days
  FROM clay_person_enrichment c
  JOIN v_expansion_targets t USING(buying_group_id)
  CROSS JOIN dataset_version v
  LEFT JOIN crm_by_email p ON p.account_id = c.account_id AND p.work_email = c.work_email COLLATE NOCASE
  LEFT JOIN group_membership member ON member.buying_group_id = c.buying_group_id AND member.person_id = p.person_id
  LEFT JOIN cs_marketing_lead lead ON lead.work_email = c.work_email COLLATE NOCASE AND
    lead.account_id = c.account_id AND lead.buying_group_id = c.buying_group_id
)
SELECT matched.*,
       CASE WHEN crm_match_count > 1 THEN 'identity_unconfirmed'
            WHEN crm_person_id IS NOT NULL THEN 'in_crm'
            WHEN email_state = 'simulated_validated' THEN 'no_match_in_demo_crm'
            ELSE 'identity_unconfirmed' END AS crm_status,
       CASE WHEN age_days IS NULL OR age_days < 0 OR age_days > 45 THEN 'check_freshness'
            WHEN employer_domain <> entity_domain OR reported_team <> buying_group THEN 'check_target_scope'
            WHEN crm_match_count > 1 THEN 'crm_identity_conflict'
            WHEN crm_person_id IS NOT NULL AND group_member_id IS NULL THEN 'crm_group_conflict'
            WHEN email_state = 'profile_only' THEN 'check_identity'
            ELSE 'eligible' END AS resolution_status
FROM matched;

CREATE VIEW v_expansion_first_party_history AS
WITH linked AS (
  SELECT t.account_id, t.buying_group_id, e.event_id, c.person_id AS identity_id, 'crm_person' AS identity_kind,
         (SELECT m.message_id FROM email_message m CROSS JOIN dataset_version v
          WHERE m.event_id = e.event_id AND m.sender_id = c.person_id AND julianday(m.sent_at) <= julianday(v.as_of_utc)
          ORDER BY m.sent_at DESC, m.message_id LIMIT 1) AS source_message_id
  FROM cs_expansion_target t
  JOIN group_membership member USING(buying_group_id)
  JOIN event_contact c ON c.person_id = member.person_id AND c.account_id = t.account_id
  JOIN v_engagement_timeline e ON e.event_id = c.event_id
  WHERE EXISTS (SELECT 1 FROM cs_event_observation o WHERE o.event_id = e.event_id AND o.use_case_id = t.use_case_id)
  UNION ALL
  SELECT rel.account_id, rel.buying_group_id, rel.event_id, rel.lead_id, 'marketing_lead', NULL
  FROM event_marketing_lead rel
)
SELECT l.*, e.occurred_at, e.source_name, e.source_record_ref, e.title,
       CASE WHEN e.event_kind = 'email' AND m.message_id IS NOT NULL THEN 'authored_email'
            WHEN e.event_kind = 'email' THEN 'thread_participation'
            WHEN e.event_kind = 'webinar' AND lower(json_extract(raw.details_json,'$.Status')) = 'attended' THEN 'webinar_attendance'
            WHEN e.event_kind = 'webinar' THEN 'webinar_registration'
            WHEN e.event_kind = 'download' THEN 'content_download'
            WHEN e.event_kind = 'meeting' THEN 'meeting_record' END AS touch_type,
       coalesce(m.body, raw.body, e.summary) AS source_text,
       e.summary, json_extract(raw.details_json,'$.Question from attendee') AS attendee_question
FROM linked l
JOIN v_engagement_timeline e USING(event_id)
JOIN engagement_event raw USING(event_id)
LEFT JOIN email_message m ON m.message_id = l.source_message_id
WHERE e.source_kind = 'first_party' AND e.event_kind IN ('email','meeting','webinar','download');
