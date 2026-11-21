ALTER TABLE account RENAME COLUMN name TO account_name;

CREATE TRIGGER account_id_insert_format
BEFORE INSERT ON account
WHEN NEW.account_id IS NULL OR typeof(NEW.account_id) <> 'text'
  OR length(NEW.account_id) = 0 OR NEW.account_id GLOB '*[^A-Za-z0-9]*'
  OR instr(NEW.account_id, char(0)) > 0
BEGIN
  SELECT RAISE(ABORT, 'account_id must be a nonempty alphanumeric string');
END;

CREATE TRIGGER account_id_update_format
BEFORE UPDATE OF account_id ON account
WHEN NEW.account_id IS NULL OR typeof(NEW.account_id) <> 'text'
  OR length(NEW.account_id) = 0 OR NEW.account_id GLOB '*[^A-Za-z0-9]*'
  OR instr(NEW.account_id, char(0)) > 0
BEGIN
  SELECT RAISE(ABORT, 'account_id must be a nonempty alphanumeric string');
END;

CREATE TABLE account_alias (
  legacy_account_id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES account(account_id)
);

ALTER TABLE subscription_contract ADD COLUMN licensed_seat_count INTEGER
  CHECK(licensed_seat_count IS NULL OR (typeof(licensed_seat_count) = 'integer' AND licensed_seat_count >= 0));

ALTER TABLE subscription_contract ADD COLUMN seat_unit TEXT;

CREATE TABLE contract_seat_usage (
  seat_usage_key TEXT PRIMARY KEY NOT NULL,
  contract_id TEXT NOT NULL REFERENCES subscription_contract(contract_id),
  measured_on TEXT NOT NULL,
  lookback_days INTEGER NOT NULL CHECK(lookback_days > 0),
  active_contributing_developers INTEGER NOT NULL
    CHECK(typeof(active_contributing_developers) = 'integer' AND active_contributing_developers >= 0),
  source_id TEXT NOT NULL REFERENCES source_system(source_id),
  UNIQUE(contract_id, measured_on, lookback_days)
);

CREATE VIEW v_contract_seat_metrics AS
SELECT c.account_id, c.contract_id, c.buying_group_id, c.product, c.seat_unit,
       c.licensed_seat_count, u.active_contributing_developers AS active_contributors_90d,
       CASE WHEN c.seat_unit = 'contributing_developer' THEN
         round(100.0 * u.active_contributing_developers / nullif(c.licensed_seat_count, 0), 2)
       END AS seat_utilization_pct,
       u.seat_usage_key, u.measured_on, u.lookback_days,
       c.source_id AS entitlement_source_id, u.source_id AS usage_source_id
FROM subscription_contract c
CROSS JOIN dataset_version v
LEFT JOIN contract_seat_usage u ON u.seat_usage_key = (
  SELECT u2.seat_usage_key FROM contract_seat_usage u2
  WHERE c.seat_unit = 'contributing_developer' AND u2.contract_id = c.contract_id
    AND u2.lookback_days = 90 AND u2.measured_on <= date(v.as_of_utc)
  ORDER BY u2.measured_on DESC LIMIT 1
)
WHERE c.status = 'active';

DROP VIEW v_account_portfolio;

CREATE VIEW v_account_portfolio AS
WITH seat_rollup AS (
  SELECT account_id, count(*) AS active_contracts,
         CASE WHEN count(CASE WHEN seat_unit = 'contributing_developer' THEN licensed_seat_count END) = count(*)
              THEN sum(licensed_seat_count) END AS licensed_seat_count,
         CASE WHEN count(*) = 1 THEN max(active_contributors_90d) END AS active_contributors_90d,
         CASE WHEN count(*) = 1 THEN max(seat_utilization_pct) END AS seat_utilization_pct,
         CASE WHEN count(*) = 1 THEN max(measured_on) END AS seat_usage_measured_on,
         CASE WHEN count(*) = 1 THEN max(seat_usage_key) END AS seat_usage_key
  FROM v_contract_seat_metrics GROUP BY account_id
), deployment_selection AS (
  SELECT account_id, count(*) AS active_deployments,
         CASE WHEN count(*) = 1 THEN max(deployment_id) END AS only_deployment_id
  FROM v_deployment_health GROUP BY account_id
)
SELECT a.account_id, a.account_name, h.health_status, h.churn_risk,
       seats.licensed_seat_count,
       CASE WHEN d.data_age_days <= 7 THEN d.adoption_pct END AS adoption_rate_pct,
       seats.active_contributors_90d, seats.seat_utilization_pct,
       d.active_repos AS repos_scanned_30d, d.in_scope_repos, d.deployment_id AS adoption_deployment_id,
       d.measured_on AS adoption_measured_on, d.snapshot_key AS adoption_snapshot_key,
       coalesce(d.quality_state, CASE WHEN ds.active_deployments > 1 THEN 'multiple_scopes' ELSE 'missing_telemetry' END)
         AS adoption_quality_state,
       seats.seat_usage_measured_on, seats.seat_usage_key,
       coalesce(seats.active_contracts, 0) AS active_contract_count,
       a.industry, a.segment, a.csm_id, p.full_name AS csm_name,
       h.assessed_on, h.source_id AS health_assessment_source_id, h.rationale,
       a.account_name AS name
FROM account a
JOIN person p ON p.person_id = a.csm_id
LEFT JOIN account_health_assessment h ON h.account_id = a.account_id
  AND h.assessed_on = (
    SELECT max(h2.assessed_on) FROM account_health_assessment h2
    WHERE h2.account_id = a.account_id
      AND h2.assessed_on <= (SELECT date(as_of_utc) FROM dataset_version)
  )
LEFT JOIN seat_rollup seats ON seats.account_id = a.account_id
LEFT JOIN deployment_selection ds ON ds.account_id = a.account_id
LEFT JOIN v_deployment_health d ON d.deployment_id = ds.only_deployment_id;
