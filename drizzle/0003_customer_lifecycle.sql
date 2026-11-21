CREATE TABLE cs_milestone (
  workstream_id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  job_kind TEXT NOT NULL CHECK(job_kind IN ('first_value','rollout')),
  deployment_id TEXT NOT NULL,
  rollout_scope TEXT NOT NULL,
  success_criterion TEXT NOT NULL,
  target_on TEXT,
  achieved_on TEXT,
  outcome_event_id TEXT,
  CHECK((achieved_on IS NULL) = (outcome_event_id IS NULL)),
  FOREIGN KEY(account_id, workstream_id, job_kind) REFERENCES cs_workstream(account_id, workstream_id, job_kind),
  FOREIGN KEY(account_id, deployment_id) REFERENCES product_deployment(account_id, deployment_id),
  FOREIGN KEY(account_id, outcome_event_id) REFERENCES engagement_event(account_id, event_id)
);
--> statement-breakpoint
CREATE TABLE cs_renewal_review (
  workstream_id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  job_kind TEXT NOT NULL CHECK(job_kind = 'renewal'),
  contract_id TEXT NOT NULL,
  annual_recurring_revenue_minor INTEGER NOT NULL CHECK(annual_recurring_revenue_minor >= 0),
  currency TEXT NOT NULL,
  notice_due_on TEXT NOT NULL,
  readiness TEXT NOT NULL CHECK(readiness IN ('evidence_pending','sponsor_review','ready')),
  sponsor_id TEXT NOT NULL,
  sponsor_ack_event_id TEXT,
  baseline_measurement_id TEXT NOT NULL REFERENCES value_measurement(measurement_id),
  observed_measurement_id TEXT NOT NULL REFERENCES value_measurement(measurement_id),
  proposed_value_target TEXT,
  FOREIGN KEY(account_id, workstream_id, job_kind) REFERENCES cs_workstream(account_id, workstream_id, job_kind),
  FOREIGN KEY(account_id, contract_id) REFERENCES subscription_contract(account_id, contract_id),
  FOREIGN KEY(account_id, sponsor_id) REFERENCES person(account_id, person_id),
  FOREIGN KEY(account_id, sponsor_ack_event_id) REFERENCES engagement_event(account_id, event_id)
);
--> statement-breakpoint
CREATE TABLE cs_risk_review (
  workstream_id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  job_kind TEXT NOT NULL CHECK(job_kind = 'risk'),
  detected_on TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('low','medium','high')),
  risk_reason TEXT NOT NULL,
  customer_impact TEXT NOT NULL,
  escalation_condition TEXT NOT NULL,
  FOREIGN KEY(account_id, workstream_id, job_kind) REFERENCES cs_workstream(account_id, workstream_id, job_kind)
);
--> statement-breakpoint
CREATE TABLE cs_expansion_review (
  workstream_id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  job_kind TEXT NOT NULL CHECK(job_kind = 'expansion'),
  evaluator_id TEXT NOT NULL,
  customer_problem TEXT NOT NULL,
  proposed_pilot_scope TEXT NOT NULL,
  pilot_success_criterion TEXT NOT NULL,
  criterion_state TEXT NOT NULL CHECK(criterion_state IN ('proposed','agreed')),
  evaluation_event_id TEXT,
  decision_on TEXT,
  budget_state TEXT NOT NULL CHECK(budget_state IN ('unconfirmed','confirmed')),
  entitlement_check TEXT NOT NULL,
  sales_handoff_condition TEXT NOT NULL,
  FOREIGN KEY(account_id, workstream_id, job_kind) REFERENCES cs_workstream(account_id, workstream_id, job_kind),
  FOREIGN KEY(account_id, evaluator_id) REFERENCES person(account_id, person_id),
  FOREIGN KEY(account_id, evaluation_event_id) REFERENCES engagement_event(account_id, event_id)
);
