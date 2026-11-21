CREATE TABLE dataset_version (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  snapshot_id TEXT NOT NULL UNIQUE,
  as_of_utc TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  dataset_kind TEXT NOT NULL CHECK(dataset_kind = 'fictional_demo')
);

CREATE TABLE source_system (
  source_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('first_party','third_party')),
  authority TEXT NOT NULL
);

CREATE TABLE person (
  person_id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES account(account_id),
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  job_title TEXT NOT NULL,
  org_team TEXT,
  person_kind TEXT NOT NULL CHECK(person_kind IN ('customer_contact','internal_staff')),
  CHECK((person_kind = 'internal_staff') = (account_id IS NULL)),
  UNIQUE(account_id, person_id)
);

CREATE TABLE account (
  account_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  industry TEXT NOT NULL,
  segment TEXT NOT NULL,
  csm_id TEXT NOT NULL REFERENCES person(person_id),
  source_id TEXT NOT NULL REFERENCES source_system(source_id)
);

CREATE TABLE account_health_assessment (
  account_id TEXT NOT NULL REFERENCES account(account_id),
  assessed_on TEXT NOT NULL,
  health_status TEXT NOT NULL CHECK(health_status IN ('Healthy','Watch','At risk')),
  churn_risk TEXT NOT NULL CHECK(churn_risk IN ('Low','Medium','High')),
  rationale TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES source_system(source_id),
  PRIMARY KEY(account_id, assessed_on)
);

CREATE TABLE buying_group (
  buying_group_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(account_id),
  name TEXT NOT NULL,
  org_unit TEXT NOT NULL,
  group_kind TEXT NOT NULL CHECK(group_kind IN ('incumbent','prospective')),
  objective TEXT NOT NULL,
  scope_note TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES source_system(source_id),
  UNIQUE(account_id, buying_group_id)
);

CREATE TABLE group_membership (
  account_id TEXT NOT NULL,
  buying_group_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  buyer_role TEXT NOT NULL,
  is_economic_buyer INTEGER NOT NULL CHECK(is_economic_buyer IN (0,1)),
  PRIMARY KEY(buying_group_id, person_id),
  FOREIGN KEY(account_id, buying_group_id) REFERENCES buying_group(account_id, buying_group_id),
  FOREIGN KEY(account_id, person_id) REFERENCES person(account_id, person_id)
);

CREATE UNIQUE INDEX one_economic_buyer_per_group
  ON group_membership(buying_group_id) WHERE is_economic_buyer = 1;

CREATE TABLE subscription_contract (
  contract_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  buying_group_id TEXT NOT NULL,
  product TEXT NOT NULL,
  renewal_on TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','expired')),
  source_id TEXT NOT NULL REFERENCES source_system(source_id),
  UNIQUE(account_id, contract_id),
  FOREIGN KEY(account_id, buying_group_id) REFERENCES buying_group(account_id, buying_group_id)
);

CREATE TABLE product_deployment (
  deployment_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  use_case TEXT NOT NULL,
  coverage_definition TEXT NOT NULL,
  UNIQUE(account_id, deployment_id),
  FOREIGN KEY(account_id, contract_id) REFERENCES subscription_contract(account_id, contract_id)
);

CREATE TABLE adoption_snapshot (
  snapshot_key TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES product_deployment(deployment_id),
  measured_on TEXT NOT NULL,
  window_days INTEGER NOT NULL CHECK(window_days > 0),
  scope_version TEXT NOT NULL,
  active_repos INTEGER NOT NULL CHECK(active_repos >= 0),
  in_scope_repos INTEGER NOT NULL CHECK(in_scope_repos > 0),
  target_pct REAL NOT NULL CHECK(target_pct BETWEEN 0 AND 100),
  source_id TEXT NOT NULL REFERENCES source_system(source_id),
  CHECK(active_repos <= in_scope_repos),
  UNIQUE(deployment_id, measured_on, window_days)
);

CREATE TABLE engagement_event (
  event_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(account_id),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('email','download','webinar','product','meeting','support','signal')),
  source_id TEXT NOT NULL REFERENCES source_system(source_id),
  source_record_ref TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT,
  details_json TEXT NOT NULL CHECK(json_valid(details_json)),
  UNIQUE(account_id, event_id),
  UNIQUE(source_id, source_record_ref)
);

CREATE INDEX engagement_account_time ON engagement_event(account_id, occurred_at DESC, event_id);

CREATE TABLE event_contact (
  account_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  PRIMARY KEY(event_id, person_id),
  FOREIGN KEY(account_id, event_id) REFERENCES engagement_event(account_id, event_id),
  FOREIGN KEY(account_id, person_id) REFERENCES person(account_id, person_id)
);

CREATE TABLE event_buying_group (
  account_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  buying_group_id TEXT NOT NULL,
  PRIMARY KEY(event_id, buying_group_id),
  FOREIGN KEY(account_id, event_id) REFERENCES engagement_event(account_id, event_id),
  FOREIGN KEY(account_id, buying_group_id) REFERENCES buying_group(account_id, buying_group_id)
);

CREATE TABLE email_message (
  message_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES engagement_event(event_id),
  sent_at TEXT NOT NULL,
  sender_id TEXT NOT NULL REFERENCES person(person_id),
  body TEXT NOT NULL
);

CREATE TABLE email_recipient (
  message_id TEXT NOT NULL REFERENCES email_message(message_id),
  recipient_id TEXT NOT NULL REFERENCES person(person_id),
  PRIMARY KEY(message_id, recipient_id)
);

CREATE TABLE value_measurement (
  measurement_id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES product_deployment(deployment_id),
  event_id TEXT NOT NULL REFERENCES engagement_event(event_id),
  metric_name TEXT NOT NULL,
  period_role TEXT NOT NULL CHECK(period_role IN ('baseline','observed')),
  value REAL NOT NULL,
  unit TEXT NOT NULL,
  measurement_scope TEXT NOT NULL,
  UNIQUE(deployment_id, metric_name, period_role, event_id)
);

CREATE TABLE qualification_signal (
  signal_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  deployment_id TEXT,
  target_group_id TEXT,
  person_id TEXT,
  signal_kind TEXT NOT NULL CHECK(signal_kind IN ('rollout_blocker','discovery_request','market_context','evaluation_path')),
  signal_state TEXT NOT NULL CHECK(signal_state IN ('open','observed','resolved')),
  observed_at TEXT NOT NULL,
  next_checkpoint_on TEXT,
  description TEXT NOT NULL,
  CHECK(
    (signal_kind = 'rollout_blocker' AND deployment_id IS NOT NULL AND target_group_id IS NULL)
    OR (signal_kind <> 'rollout_blocker' AND target_group_id IS NOT NULL)
  ),
  FOREIGN KEY(account_id, event_id) REFERENCES engagement_event(account_id, event_id),
  FOREIGN KEY(account_id, deployment_id) REFERENCES product_deployment(account_id, deployment_id),
  FOREIGN KEY(account_id, target_group_id) REFERENCES buying_group(account_id, buying_group_id),
  FOREIGN KEY(account_id, person_id) REFERENCES person(account_id, person_id)
);

CREATE VIEW v_account_portfolio AS
SELECT a.account_id, a.name, a.industry, a.segment, a.csm_id,
       p.full_name AS csm_name, h.assessed_on, h.health_status, h.churn_risk, h.rationale
FROM account a
JOIN person p ON p.person_id = a.csm_id
LEFT JOIN account_health_assessment h ON h.account_id = a.account_id
  AND h.assessed_on = (
    SELECT max(h2.assessed_on) FROM account_health_assessment h2
    WHERE h2.account_id = a.account_id
      AND h2.assessed_on <= (SELECT date(as_of_utc) FROM dataset_version)
  );

CREATE VIEW v_buying_group_members AS
SELECT g.account_id, g.buying_group_id, g.name AS group_name, g.org_unit,
       g.group_kind, g.objective, g.scope_note,
       m.person_id, p.full_name, p.job_title, p.org_team, m.buyer_role, m.is_economic_buyer
FROM buying_group g
LEFT JOIN group_membership m ON g.buying_group_id = m.buying_group_id
LEFT JOIN person p ON p.person_id = m.person_id;

CREATE VIEW v_engagement_timeline AS
SELECT e.event_id, e.account_id, e.occurred_at, e.event_kind, e.title, e.summary,
       e.source_record_ref, s.source_id, s.name AS source_name, s.source_kind
FROM engagement_event e JOIN source_system s USING(source_id)
WHERE julianday(e.occurred_at) <= (SELECT julianday(as_of_utc) FROM dataset_version);

CREATE VIEW v_adoption_history AS
SELECT d.account_id, c.buying_group_id, d.deployment_id, a.snapshot_key,
       a.measured_on, a.window_days, a.scope_version, a.active_repos, a.in_scope_repos,
       round(100.0 * a.active_repos / a.in_scope_repos, 2) AS adoption_pct,
       a.target_pct, a.source_id
FROM adoption_snapshot a
JOIN product_deployment d USING(deployment_id)
JOIN subscription_contract c USING(contract_id)
WHERE a.measured_on <= (SELECT date(as_of_utc) FROM dataset_version);

CREATE VIEW v_deployment_health AS
WITH latest AS (
  SELECT *, row_number() OVER (PARTITION BY deployment_id ORDER BY measured_on DESC) AS position
  FROM v_adoption_history WHERE window_days = 30
), paired AS (
  SELECT d.account_id, d.deployment_id, d.use_case, d.coverage_definition,
         c.contract_id, c.buying_group_id, c.product, c.renewal_on,
         l.snapshot_key, l.source_id, l.measured_on, l.scope_version,
         l.active_repos, l.in_scope_repos, l.adoption_pct, l.target_pct,
         b.snapshot_key AS baseline_key, b.measured_on AS baseline_on,
         b.scope_version AS baseline_scope, b.in_scope_repos AS baseline_repos,
         b.adoption_pct AS baseline_pct,
         CAST(julianday(date(v.as_of_utc)) - julianday(l.measured_on) AS INTEGER) AS data_age_days
  FROM product_deployment d JOIN subscription_contract c USING(contract_id)
  CROSS JOIN dataset_version v
  LEFT JOIN latest l ON l.deployment_id = d.deployment_id AND l.position = 1
  LEFT JOIN v_adoption_history b ON b.snapshot_key = (
    SELECT b2.snapshot_key FROM v_adoption_history b2
    WHERE b2.deployment_id = d.deployment_id AND b2.window_days = l.window_days
      AND b2.measured_on BETWEEN date(l.measured_on,'-35 days') AND date(l.measured_on,'-28 days')
    ORDER BY b2.measured_on DESC LIMIT 1
  )
  WHERE c.status = 'active'
), evaluated AS (
  SELECT paired.*,
    CASE WHEN snapshot_key IS NULL THEN 'missing_telemetry'
         WHEN data_age_days > 7 THEN 'stale_telemetry'
         WHEN baseline_key IS NULL THEN 'insufficient_history'
         WHEN scope_version <> baseline_scope OR in_scope_repos <> baseline_repos THEN 'scope_changed'
         ELSE 'comparable' END AS quality_state
  FROM paired
)
SELECT evaluated.*,
  CASE WHEN quality_state = 'comparable' THEN round(adoption_pct - baseline_pct, 2) END AS change_pp,
  CASE WHEN quality_state <> 'comparable' THEN 'verify_data'
       WHEN (target_pct - adoption_pct) >= 10 AND (adoption_pct - baseline_pct) <= 3 THEN 'stalled'
       WHEN adoption_pct >= target_pct THEN 'on_target'
       ELSE 'progressing' END AS adoption_state
FROM evaluated;

CREATE VIEW v_expansion_discovery AS
WITH candidates AS (
  SELECT q.*, g.name AS target_group_name,
         m.person_id AS economic_buyer_id,
         row_number() OVER (PARTITION BY q.target_group_id ORDER BY q.observed_at DESC, q.signal_id) AS position
  FROM qualification_signal q
  JOIN buying_group g ON g.buying_group_id = q.target_group_id AND g.group_kind = 'prospective'
  JOIN group_membership requested ON requested.buying_group_id = q.target_group_id AND requested.person_id = q.person_id
  JOIN event_buying_group evidenced ON evidenced.event_id = q.event_id AND evidenced.buying_group_id = q.target_group_id
  JOIN event_contact participant ON participant.event_id = q.event_id AND participant.person_id = q.person_id
  JOIN v_engagement_timeline e ON e.event_id = q.event_id
  LEFT JOIN group_membership m ON m.buying_group_id = q.target_group_id AND m.is_economic_buyer = 1
  WHERE q.signal_kind = 'discovery_request' AND q.signal_state = 'open'
    AND e.source_kind = 'first_party' AND e.event_kind IN ('email','meeting')
    AND julianday(q.observed_at) BETWEEN (SELECT julianday(as_of_utc) - 60 FROM dataset_version)
                                    AND (SELECT julianday(as_of_utc) FROM dataset_version)
)
SELECT signal_id, account_id, event_id, target_group_id, target_group_name, person_id, economic_buyer_id,
       observed_at, description, 'discovery_requested' AS stage
FROM candidates WHERE position = 1;

CREATE VIEW v_work_queue AS
SELECT d.deployment_id || '/stalled-adoption' AS case_id, d.account_id,
       'stalled_adoption' AS playbook, d.deployment_id, d.buying_group_id AS buying_group_id,
       d.snapshot_key AS evidence_snapshot_key, b.event_id AS evidence_event_id,
       b.signal_id AS evidence_signal_id, b.next_checkpoint_on,
       'investigate_rollout' AS stage, coalesce(b.description,'Confirm the cause and next rollout milestone.') AS why_now
FROM v_deployment_health d
LEFT JOIN qualification_signal b ON b.signal_id = (
  SELECT b2.signal_id FROM qualification_signal b2 JOIN v_engagement_timeline e ON e.event_id = b2.event_id
  WHERE b2.signal_kind = 'rollout_blocker' AND b2.signal_state = 'open' AND b2.deployment_id = d.deployment_id
  ORDER BY b2.observed_at DESC, b2.signal_id LIMIT 1
)
WHERE d.adoption_state = 'stalled'
UNION ALL
SELECT buying_group_id || '/expansion' AS case_id, account_id, 'expansion', NULL, buying_group_id,
       NULL, event_id, signal_id, NULL, stage, description
FROM (
  SELECT target_group_id AS buying_group_id, account_id, event_id, signal_id, stage, description
  FROM v_expansion_discovery
);
