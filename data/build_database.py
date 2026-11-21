"""Rebuild the canonical fictional data from its source snapshot."""
from collections import defaultdict
import json
from pathlib import Path
import re
import sqlite3
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
FIXTURE = json.loads((HERE / "source_fixture.json").read_text(encoding="utf-8"))
RESEARCH = json.loads((HERE / "expansion_research_fixture.json").read_text(encoding="utf-8"))
SCHEMA = (HERE / "schema.sql").read_text(encoding="utf-8")
ACCOUNT_METRICS_SCHEMA = (HERE / "account_metrics.sql").read_text(encoding="utf-8")
CUSTOMER_ACTIONS_SCHEMA = (HERE / "customer_actions.sql").read_text(encoding="utf-8")
CUSTOMER_LIFECYCLE_SCHEMA = (HERE / "customer_lifecycle.sql").read_text(encoding="utf-8")
PRODUCT_GROUNDING_SCHEMA = (HERE / "product_grounding.sql").read_text(encoding="utf-8")
EXPANSION_RESEARCH_SCHEMA = (HERE / "expansion_research.sql").read_text(encoding="utf-8")
OUTREACH_SCHEMA = (HERE / "outreach.sql").read_text(encoding="utf-8")
AS_OF = FIXTURE["snapshotDate"] + "T20:00:00Z"
BASE_SNAPSHOT = "endor-cs-demo-2026-11-20"
PREVIOUS_SNAPSHOT = BASE_SNAPSHOT + "-v2"
WORKFLOW_SNAPSHOT = BASE_SNAPSHOT + "-v3"
PRODUCT_SNAPSHOT = BASE_SNAPSHOT + "-v4"
SNAPSHOT_ID = BASE_SNAPSHOT + "-v5"
OWNER_ID = "staff:morgan"
ROWS = defaultdict(list)
CRM = "salesforce"
PRODUCT = "product_telemetry"

# Source aliases stay stable for older tool calls and existing child record IDs.
# The values are fictional contract entitlements and 90-day contributor counts.
ACCOUNT_METRICS = {
    "brackenpay": ("AC0001", 150, 86),
    "astervale": ("AC0002", 200, 110),
    "copperline": ("AC0003", 200, 166),
    "stratos": ("AC0004", 120, 108),
    "ironvale": ("AC0005", 100, 68),
}

SOURCES = [
    (CRM, "Salesforce CRM", "first_party", "Account ownership, contract entitlements, buying groups and meeting notes"),
    (PRODUCT, "Endor Labs product telemetry", "first_party", "Capability-specific scans, contributing developers and scoped value observations"),
    ("customer_email", "Customer email", "first_party", "Customer statements, introductions and commitments"),
    ("marketing", "Marketing events", "first_party", "Webinar registrations, attendance and content downloads"),
    ("support", "Support cases", "first_party", "Implementation blockers and updates"),
    ("market_research", "Market research", "third_party", "Context about public initiatives and hiring"),
    ("cs_review", "CSM assessment", "first_party", "Qualitative customer health and churn-risk assessment")
]
EVENT_SOURCES = {
    "email": "customer_email", "product": PRODUCT, "meeting": CRM, "support": "support",
    "webinar": "marketing", "download": "marketing", "signal": "market_research",
}
INCUMBENTS = {
    "brackenpay": ("payments-security", "Payments Rollout", "Payments · AppSec and Platform",
                  "Roll out dependency scanning across Payments repositories."),
    "astervale": ("clinical-appsec", "Clinical Application Security", "Clinical Platform and Integrations",
                  "Extend reachability analysis across the contracted Clinical teams."),
    "stratos": ("storefront", "Storefront", "Storefront Engineering",
                "Reduce triage time for container image findings across Storefront services."),
    "ironvale": ("routing", "Routing Security", "Routing Engineering",
                 "Roll out Endor Code AI SAST and route first-party code findings to engineering owners."),
}
WORKFLOW_TABLES = ("cs_workstream", "cs_action", "cs_milestone", "cs_renewal_review", "cs_risk_review", "cs_expansion_review")
PRODUCT_TABLES = ("product_catalog", "product_capability", "cs_product_use_case", "cs_event_observation", "cs_workstream_use_case")
RESEARCH_TABLES = ("cs_expansion_target", "sumble_org_signal", "clay_person_enrichment", "cs_marketing_lead", "event_marketing_lead")

def insert(table, *values):
    ROWS[table].append(values)

def key(account, suffix):
    return account + ":" + suffix

def person_key(account, identifier):
    return OWNER_ID if identifier == "morgan" else key(account, identifier)

def group_rows(account):
    if account.get("buyingGroups"):
        return account["buyingGroups"]
    aid = account["id"]
    group_id, name, org, goal = INCUMBENTS[aid]
    groups = [{"id": group_id, "name": name, "org": org, "goal": goal, "state": "Current customer",
               "buyer": None, "scope": f"{account['scoped']} repositories in the existing scope."}]
    if aid == "stratos":
        groups.append({"id": "fulfillment", "name": "Fulfillment", "org": "Fulfillment Engineering",
                       "goal": "Evaluate image scanning and reachability on images from three service repositories.",
                       "state": "New buying group", "buyer": None,
                       "scope": "Discovery request recorded. Economic buyer still to be confirmed."})
    return groups

def measurement(value):
    match = re.fullmatch(r"([\d.]+)\s*(days|hours|%)", value)
    if match is None:
        raise ValueError(f"Unrecognized measurement {value}")
    unit = {"days": "days", "hours": "hours/week", "%": "percent"}[match[2]]
    return float(match[1]), unit

def load_fixture():
    insert("dataset_version", 1, SNAPSHOT_ID, AS_OF, "cs-eligibility-v1", "fictional_demo")
    for row in SOURCES:
        insert("source_system", *row)
    owner = FIXTURE["owner"]
    insert("person", OWNER_ID, None, owner["name"], owner["email"], owner["title"], "Customer Success", "internal_staff")

    for account in FIXTURE["accounts"]:
        aid = account["id"]
        account_id, licensed_seats, active_contributors = ACCOUNT_METRICS[aid]
        insert("account", account_id, account["name"], account["industry"], account["segment"], OWNER_ID, CRM)
        insert("account_alias", aid, account_id)
        insert("account_health_assessment", account_id, FIXTURE["snapshotDate"], account["health"],
               account["risk"], account["healthReason"], "cs_review")

        groups = group_rows(account)
        incumbent = next(group for group in groups if group["state"] == "Current customer")
        group_map = {group["id"]: group for group in groups}
        for group in groups:
            kind = "incumbent" if group["state"] == "Current customer" else "prospective"
            insert("buying_group", key(aid, group["id"]), account_id, group["name"], group["org"], kind,
                   group["goal"], group["scope"], CRM)
        contacts = {}
        for person in account["contacts"]:
            pid = person_key(aid, person["id"])
            contacts[person["id"]] = person.get("buyingGroupId") or (
                "fulfillment" if person["scope"] == "Adjacent buying group" else incumbent["id"])
            group = group_map[contacts[person["id"]]]
            insert("person", pid, account_id, person["name"], person["email"], person["title"], person["team"], "customer_contact")
            insert("group_membership", account_id, key(aid, group["id"]), pid, person["role"], int(group["buyer"] == person["id"]))

        contract = key(aid, "primary-contract")
        deployment = key(aid, "primary-deployment")
        insert("subscription_contract", contract, account_id, key(aid, incumbent["id"]), account["product"],
               account["renewal"], "active", CRM, licensed_seats, "contributing_developer")
        insert("contract_seat_usage", key(contract, FIXTURE["snapshotDate"]), contract,
               FIXTURE["snapshotDate"], 90, active_contributors, PRODUCT)
        insert("product_deployment", deployment, account_id, contract, account["useCase"], account["coverageDefinition"])
        for measured_on, active in zip(FIXTURE["trendDates"], account["scans"], strict=True):
            insert("adoption_snapshot", key(deployment, measured_on), deployment, measured_on, 30, "contract-scope-v1",
                   active, account["scoped"], account["target"], PRODUCT)

        events = {}
        for item in account["events"]:
            eid = item["id"]
            events[eid] = item
            insert("engagement_event", eid, account_id, item["type"], EVENT_SOURCES[item["type"]], "demo:" + eid,
                   item["at"], item["title"], item["summary"], item.get("body"),
                   json.dumps(dict(item.get("fields", [])), ensure_ascii=False))
            ids = item["contactIds"]
            for contact_id in ids:
                insert("event_contact", account_id, eid, person_key(aid, contact_id))
            scoped_groups = item.get("buyingGroupIds") or sorted({contacts[x] for x in ids})
            if not scoped_groups and item["type"] == "product":
                scoped_groups = [incumbent["id"]]
            if eid == "sc-signal":
                scoped_groups = ["fulfillment"]
            for group_id in scoped_groups:
                insert("event_buying_group", account_id, eid, key(aid, group_id))
            for index, message in enumerate(item.get("messages", []), 1):
                mid = key(eid, f"message-{index}")
                insert("email_message", mid, eid, message["at"], person_key(aid, message["from"]), message["body"])
                for recipient in message["to"]:
                    insert("email_recipient", mid, person_key(aid, recipient))

        value = account["value"]
        for role, label in [("baseline", "before"), ("observed", "after")]:
            number, unit = measurement(value[label])
            insert("value_measurement", key(deployment, role), deployment, value["eventId"], value["label"],
                   role, number, unit, value["scope"])

        signals = {
            "brackenpay": [("bp-email", "rollout_blocker", "open", None, "theo", "2026-11-24")],
            "astervale": [("av-case", "rollout_blocker", "open", None, "jordan", "2026-11-23")],
            "copperline": [
                ("cc-email", "discovery_request", "open", "platform-engineering", "drew", None),
                ("cc-eval", "evaluation_path", "observed", "platform-engineering", "rina", None),
                ("cc-signal", "market_context", "observed", "platform-engineering", None, None),
            ],
            "stratos": [
                ("sc-meeting", "discovery_request", "open", "fulfillment", "felix", None),
                ("sc-signal", "market_context", "observed", "fulfillment", None, None),
            ],
        }
        for eid, kind, state, target_group, contact_id, checkpoint in signals.get(aid, []):
            description, = [obs["observedText"] for obs in events[eid]["observations"] if obs["kind"] == kind]
            insert("qualification_signal", key(eid, kind), account_id, eid,
                   deployment if kind == "rollout_blocker" else None,
                   key(aid, target_group) if target_group else None,
                   person_key(aid, contact_id) if contact_id else None,
                   kind, state, events[eid]["at"], checkpoint, description)

def load_workstreams():
    def add(account, group, kind, title, objective, evidence, action, due, contact=None, case=None):
        account_id = ACCOUNT_METRICS[account][0]
        workstream_id = key(account, kind)
        insert("cs_workstream", workstream_id, account_id, key(account, group), kind, title, objective, case, evidence)
        insert("cs_action", workstream_id + "/initial", account_id, workstream_id, OWNER_ID,
               person_key(account, contact) if contact else None, action, due, None, AS_OF)
        return workstream_id, account_id, kind

    clinical = add("astervale", "clinical-appsec", "rollout", "Clinical Integrations rollout",
                   "Reach 80% Endor Open Source coverage across the contracted Clinical repositories.", "av-case",
                   "Confirm the first three repository owners with Jordan", "2026-11-23", "jordan",
                   "astervale:primary-deployment/stalled-adoption")
    insert("cs_milestone", *clinical, "astervale:primary-deployment", "15 Clinical Integrations repositories",
           "Name the first three repository owners to unblock the batch and route reachable dependency findings.", "2026-11-23", None, None)

    payments = add("brackenpay", "payments-security", "rollout", "Payments adoption recovery",
                   "Resume Endor Open Source onboarding toward 75% Payments dependency-scanning coverage.", "bp-email",
                   "Confirm GitHub App permission approval with Theo", "2026-11-24", "theo",
                   "brackenpay:primary-deployment/stalled-adoption")
    insert("cs_milestone", *payments, "brackenpay:primary-deployment", "Next 10 Payments API repositories",
           "Verify approval of the Endor Labs GitHub App before committing the next ten repositories to dependency scanning.", "2026-11-24", None, None)

    first_value = add("ironvale", "routing", "first_value", "First successful scans for the new Routing batch",
                      "Bring the next five Routing repositories to their first successful Endor Code AI SAST scan.", "il-email",
                      "Verify the first successful scans for Sofia’s five repositories", "2026-12-01", "sofia")
    insert("cs_milestone", *first_value, "ironvale:primary-deployment", "Five newly added Routing repositories",
           "Verify a first successful AI SAST scan in each repository and confirm where owners review first-party code findings.", "2026-12-01", None, None)

    renewal = add("brackenpay", "payments-security", "renewal", "Payments value review before renewal",
                  "Give Priya a scoped Endor Open Source adoption and dependency remediation review before the notice deadline.", "bp-meeting",
                  "Prepare the scoped value review and confirm Priya’s success criteria", "2026-12-04", "priya")
    insert("cs_renewal_review", *renewal, "brackenpay:primary-contract", 18000000, "USD", "2027-01-16",
           "evidence_pending", "brackenpay:priya", None, "brackenpay:primary-deployment:baseline",
           "brackenpay:primary-deployment:observed", "Validate with Priya whether a seven-day median is the right target.")

    risk = add("brackenpay", "payments-security", "risk", "Payments renewal risk intervention",
               "Unblock Endor Open Source onboarding while protecting the Payments renewal.", "bp-email",
               "Review the approval outcome and escalate internally if it slipped", "2026-11-25")
    insert("cs_risk_review", *risk, "2026-11-19", "high", "Payments needs organization-level Endor Labs GitHub App approval for SCA.",
           "Current coverage is 34 of 100 repositories against the agreed 75. The next 10 are on hold.",
           "If November 24 passes without approval or a credible decision date, align with Support and the account team.")

    copperline = add("copperline", "platform-engineering", "expansion", "Platform Engineering pilot discovery",
                     "Validate whether Endor Open Source in shared CI templates can reduce the work to enable dependency checks.", "cc-email",
                     "Agree on the pilot baseline and decision criteria with Drew", "2026-11-25", "drew", "copperline:platform-engineering/expansion")
    insert("cs_expansion_review", *copperline, "copperline:drew", "Teams spend time enabling dependency checks in CI.",
           "Two shared CI templates owned by Platform Engineering.",
           "Verify dependency scans and usable reachability results on both templates. Compare setup time per team against a separate baseline.",
           "proposed", "cc-eval", None, "unconfirmed", "Verify whether the incumbent entitlement covers the new team and repositories.",
           "Handoff after Drew agrees to the pilot and Rina confirms the funding path and decision date.")

    stratos = add("stratos", "fulfillment", "expansion", "Fulfillment service pilot discovery",
                  "Evaluate Endor Open Source image scanning on images from three Fulfillment repositories.", "sc-meeting",
                  "Map the three repositories and ask Felix who owns funding", "2026-11-30", "felix", "stratos:fulfillment/expansion")
    insert("cs_expansion_review", *stratos, "stratos:felix", "Fulfillment wants a consistent way to prioritize container image findings.",
           "Images built from three Fulfillment service repositories, with a service owner participating.",
           "Verify image scans for three services. Agree with Felix on a scoped triage baseline and success criteria.",
           "proposed", None, None, "unconfirmed", "Validate whether Fulfillment’s repositories fall within the existing agreement.",
           "Handoff once the scope, success criteria, decision owner and funding path are confirmed.")

def load_product_grounding():
    for item in FIXTURE["productCatalog"]:
        insert("product_catalog", item["id"], item["name"], item["description"], item["officialUrl"])
    for item in FIXTURE["productCapabilities"]:
        insert("product_capability", item["id"], item["productLineId"], item["name"], item["problem"], item["officialUrl"])

    signals = {(row[2], row[6]): row[0] for row in ROWS["qualification_signal"]}
    event_groups = {(row[1], row[2]) for row in ROWS["event_buying_group"]}
    cases_by_group = {}
    for account in FIXTURE["accounts"]:
        aid = account["id"]
        account_id = ACCOUNT_METRICS[aid][0]
        use_cases = {item["id"]: item for item in account["productUseCases"]}
        for item in use_cases.values():
            group_id = key(aid, item["buyingGroupId"])
            use_case_id = key(aid, item["id"])
            if group_id in cases_by_group:
                raise ValueError(f"A workstream needs an explicit use case for group {group_id}.")
            cases_by_group[group_id] = use_case_id
            deployment = key(aid, "primary-deployment") if item["stage"] == "deployed" else None
            insert("cs_product_use_case", use_case_id, account_id, group_id, deployment, item["capabilityId"],
                   item["stage"], item["label"], item["customerProblem"], item["workflow"],
                   item["adoptionDefinition"], item["successMeasure"])

        for event in account["events"]:
            event_id = event["id"]
            for index, item in enumerate(event["observations"], 1):
                case = use_cases[item["useCaseId"]]
                if (event_id, key(aid, case["buyingGroupId"])) not in event_groups:
                    raise ValueError(f"Event {event_id} is missing the observation's buying group.")
                source = item["sourcePart"]
                message_index = item.get("message")
                message = None
                if source == "email_message":
                    if not message_index or message_index > len(event.get("messages", [])):
                        raise ValueError(f"Observation {event_id}/{index} needs an original thread message.")
                    message = key(event_id, f"message-{message_index}")
                elif not event.get(source):
                    raise ValueError(f"Observation {event_id}/{index} needs source text.")
                insert("cs_event_observation", key(event_id, f"observation-{index}"), account_id, event_id,
                       key(aid, case["id"]), item["kind"], item["evidenceRole"], item["observedText"], source,
                       message, signals.get((event_id, item["kind"])))

    for workstream_id, account_id, group_id, *_ in ROWS["cs_workstream"]:
        insert("cs_workstream_use_case", workstream_id, account_id, cases_by_group[group_id])

def load_expansion_research():
    if RESEARCH["mode"] != "simulated":
        raise ValueError("The expansion research fixture must identify its data as simulated.")
    targets = {target["buyingGroupId"]: target for target in RESEARCH["targets"]}
    for group_id, target in targets.items():
        insert("cs_expansion_target", group_id, target["accountId"], target["useCaseId"], target["entityName"],
               target["entityDomain"], target["relationship"], target["incumbentGroupId"], target["introductionOwnerId"],
               target["introductionEventId"], target["discussion"], target["contractQuestion"])

    for signal in RESEARCH["sumbleSignals"]:
        group_id = signal["group"]
        insert("sumble_org_signal", signal["id"], targets[group_id]["accountId"], group_id, signal["kind"], signal["at"],
               signal["title"], signal["excerpt"], json.dumps(signal["technologies"]), signal["hypothesis"], signal["url"],
               "simulated:" + signal["id"])

    for person in RESEARCH["clayPeople"]:
        group_id = person["group"]
        email = person["email"].strip().lower() if person["email"] else None
        if email and not email.endswith("@" + person["domain"]):
            raise ValueError(f"Fictional work email does not match the simulated employer for {person['id']}.")
        insert("clay_person_enrichment", person["id"], targets[group_id]["accountId"], group_id, person["name"],
               person["title"], person["team"], person["domain"], email, "simulated_validated" if email else "profile_only",
               person["persona"], person["basis"], person["signal"], person["at"], person["profile"], "simulated:" + person["id"])

    leads = {lead["id"]: lead for lead in RESEARCH["marketingLeads"]}
    for lead_id, lead in leads.items():
        group_id = lead["group"]
        insert("cs_marketing_lead", lead_id, targets[group_id]["accountId"], group_id, lead["name"],
               lead["email"].strip().lower(), lead["sourceRef"])

    for event in RESEARCH["marketingEvents"]:
        lead_id = event["lead"]
        group_id = leads[lead_id]["group"]
        target = targets[group_id]
        event_id, account_id = event["id"], target["accountId"]
        details = {"Asset": event["title"], "Status": event["status"]}
        if "scheduledAt" in event:
            details["Scheduled"] = event["scheduledAt"]
        if "attendeeQuestion" in event:
            details["Question from attendee"] = event["attendeeQuestion"]
        insert("engagement_event", event_id, account_id, event["kind"], "marketing", "demo:" + event_id,
               event["at"], event["title"], event["summary"], event["body"], json.dumps(details))
        insert("event_buying_group", account_id, event_id, group_id)
        insert("cs_event_observation", key(event_id, "observation-1"), account_id, event_id, target["useCaseId"],
               "enablement_engagement", "passive_engagement", event["summary"], "summary", None, None)
        insert("event_marketing_lead", event_id, account_id, group_id, lead_id)

def load_plan():
    order = (
        ("dataset_version", ROWS["dataset_version"]), ("source_system", ROWS["source_system"]),
        ("person", ROWS["person"][:1]), ("account", ROWS["account"]), ("person", ROWS["person"][1:]),
    )
    tables = (
        "account_alias", "account_health_assessment", "buying_group", "group_membership", "subscription_contract", "contract_seat_usage",
        "product_deployment", "adoption_snapshot", "engagement_event", "event_contact", "event_buying_group",
        "email_message", "email_recipient", "value_measurement", "qualification_signal", *WORKFLOW_TABLES, *PRODUCT_TABLES,
        *RESEARCH_TABLES,
    )
    return (*order, *((table, ROWS[table]) for table in tables))

def insert_operations(plan):
    operations = []
    for table, rows in plan:
        if not rows:
            continue
        width = len(rows[0])
        chunk = 90 // width
        placeholders = "(" + ",".join("?" for _ in range(width)) + ")"
        for start in range(0, len(rows), chunk):
            subset = rows[start:start + chunk]
            operations.append({
                "sql": f"INSERT INTO {table} VALUES " + ",".join([placeholders] * len(subset)) + " ON CONFLICT DO NOTHING",
                "values": [value for row in subset for value in row],
            })
    return operations

def deploy_seed(plan, db):
    def operation(sql, *values):
        return {"sql": sql, "values": values}

    aliases = ROWS["account_alias"]
    alias_cases = " ".join("WHEN ? THEN ?" for _ in aliases)
    old_ids = [prior for prior, _ in aliases]
    placeholders = ",".join("?" for _ in aliases)
    replacements = [value for pair in aliases for value in pair]
    account_tables = (
        "account", "person", "account_health_assessment", "buying_group", "group_membership",
        "subscription_contract", "product_deployment", "engagement_event", "event_contact",
        "event_buying_group", "qualification_signal",
    )
    # D1 applies the ordered batch as one transaction and checks all keys at commit.
    upgrade = [operation("PRAGMA defer_foreign_keys = ON")]
    for table in account_tables:
        upgrade.append(operation(
            f"UPDATE {table} SET account_id = CASE account_id {alias_cases} END "
            f"WHERE account_id IN ({placeholders})",
            *replacements, *old_ids,
        ))
    for source_id, _, _, authority in SOURCES[:2]:
        upgrade.append(operation("UPDATE source_system SET authority = ? WHERE source_id = ?", authority, source_id))
    for contract in ROWS["subscription_contract"]:
        upgrade.append(operation(
            "UPDATE subscription_contract SET licensed_seat_count = ?, seat_unit = ? WHERE contract_id = ?",
            contract[-2], contract[-1], contract[0],
        ))
    upgrade.extend(insert_operations([
        ("account_alias", ROWS["account_alias"]),
        ("contract_seat_usage", ROWS["contract_seat_usage"]),
    ]))
    actions = insert_operations((table, ROWS[table]) for table in WORKFLOW_TABLES)
    product_context = insert_operations((table, ROWS[table]) for table in PRODUCT_TABLES)
    new_event_ids = {event["id"] for event in RESEARCH["marketingEvents"]}
    research_events = insert_operations((table, [row for row in ROWS[table] if row[index] in new_event_ids])
                                        for table, index in (("engagement_event", 0), ("event_buying_group", 1)))
    new_observations = [row for row in ROWS["cs_event_observation"] if row[2] in new_event_ids]
    research_observations = insert_operations([("cs_event_observation", new_observations)])
    research_facts = insert_operations((table, ROWS[table]) for table in RESEARCH_TABLES)
    # Refresh only fictional source columns. The action register and its audit rows are independent.
    refresh_columns = (
        ("source_system", ("source_id",), ("name", "authority")),
        ("subscription_contract", ("contract_id",), ("product",)),
        ("product_deployment", ("deployment_id",), ("use_case", "coverage_definition")),
        ("buying_group", ("buying_group_id",), ("objective", "scope_note")),
        ("account_health_assessment", ("account_id", "assessed_on"), ("rationale",)),
        ("engagement_event", ("event_id",), ("event_kind", "source_id", "title", "summary", "body", "details_json")),
        ("email_message", ("message_id",), ("body",)),
        ("value_measurement", ("measurement_id",), ("metric_name", "measurement_scope")),
        ("qualification_signal", ("signal_id",), ("description",)),
        ("cs_workstream", ("workstream_id",), ("customer_objective",)),
        ("cs_milestone", ("workstream_id",), ("success_criterion",)),
        ("cs_risk_review", ("workstream_id",), ("risk_reason",)),
        ("cs_expansion_review", ("workstream_id",), ("customer_problem", "proposed_pilot_scope", "pilot_success_criterion")),
    )
    refresh = []
    for table, keys, fields in refresh_columns:
        names = fields + keys
        values = db.execute(f"SELECT {','.join(names)} FROM {table} ORDER BY {','.join(keys)}").fetchall()
        width = len(names)
        rows_per_statement = 90 // width
        slots = "(" + ",".join("?" for _ in names) + ")"
        assignments = ",".join(f"{field}=updated.{field}" for field in fields)
        match = " AND ".join(f"current.{column}=updated.{column}" for column in keys)
        for index in range(0, len(values), rows_per_statement):
            batch = values[index:index + rows_per_statement]
            refresh.append(operation(
                f"WITH updated({','.join(names)}) AS (VALUES {','.join([slots] * len(batch))}) "
                f"UPDATE {table} AS current SET {assignments} FROM updated WHERE {match}",
                *(value for row in batch for value in row),
            ))

    def completed(previous):
        return operation("UPDATE dataset_version SET snapshot_id = ? WHERE snapshot_id = ?", SNAPSHOT_ID, previous)

    seed = {"snapshot_id": SNAPSHOT_ID, "fresh": insert_operations(plan), "upgrades": {
        BASE_SNAPSHOT: [*upgrade, *actions, *refresh, *research_events, *product_context, *research_facts, completed(BASE_SNAPSHOT)],
        PREVIOUS_SNAPSHOT: [*actions, *refresh, *research_events, *product_context, *research_facts, completed(PREVIOUS_SNAPSHOT)],
        WORKFLOW_SNAPSHOT: [*refresh, *research_events, *product_context, *research_facts, completed(WORKFLOW_SNAPSHOT)],
        PRODUCT_SNAPSHOT: [*research_events, *research_observations, *research_facts, completed(PRODUCT_SNAPSHOT)],
    }}
    (HERE / "hosted_seed.json").write_text(json.dumps(seed, ensure_ascii=False) + "\n", encoding="utf-8")

def migration_statements(schema):
    statements, buffer = [], ""
    for line in (schema.rstrip() + "\n").splitlines(keepends=True):
        buffer += line
        if sqlite3.complete_statement(buffer):
            statements.append(buffer.strip())
            buffer = ""
    if buffer.strip():
        raise ValueError("Incomplete migration statement")
    return "\n--> statement-breakpoint\n".join(statements) + "\n"

def deploy_migration():
    destination = ROOT / "drizzle"
    if not destination.is_dir():
        return
    path = destination / "meta" / "_journal.json"
    journal = json.loads(path.read_text(encoding="utf-8"))
    entries = journal["entries"]
    for tag, schema in (("0001_account_metrics", ACCOUNT_METRICS_SCHEMA), ("0002_customer_actions", CUSTOMER_ACTIONS_SCHEMA),
                        ("0003_customer_lifecycle", CUSTOMER_LIFECYCLE_SCHEMA), ("0004_product_grounding", PRODUCT_GROUNDING_SCHEMA),
                        ("0005_expansion_research", EXPANSION_RESEARCH_SCHEMA), ("0006_outreach", OUTREACH_SCHEMA)):
        (destination / (tag + ".sql")).write_text(migration_statements(schema), encoding="utf-8")
        if not any(entry["tag"] == tag for entry in entries):
            entries.append({
                "idx": len(entries), "version": "6", "when": entries[-1]["when"] + 1, "tag": tag, "breakpoints": True,
            })
    (destination / "meta" / "_journal.json").write_text(json.dumps(journal, indent=2) + "\n", encoding="utf-8")

def validate_product_grounding(db):
    checks = (
        ("Unmapped event", """SELECT e.event_id FROM engagement_event e
          WHERE NOT EXISTS (SELECT 1 FROM v_event_observations o WHERE o.event_id = e.event_id AND length(o.source_text) > 0)"""),
        ("Unmapped email message", """SELECT m.message_id FROM email_message m
          WHERE NOT EXISTS (SELECT 1 FROM v_event_observations o WHERE o.source_message_id = m.message_id)"""),
        ("Missing or mismatched workstream evidence", """SELECT w.workstream_id FROM cs_workstream w
          LEFT JOIN cs_workstream_use_case l USING(workstream_id)
          LEFT JOIN cs_product_use_case u USING(use_case_id)
          WHERE u.use_case_id IS NULL OR u.buying_group_id <> w.buying_group_id
             OR NOT EXISTS (SELECT 1 FROM v_event_observations o WHERE o.event_id = w.evidence_event_id AND o.use_case_id = u.use_case_id)
             OR (w.case_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM v_work_queue q WHERE q.case_id = w.case_id))"""),
        ("Mismatched product for deployment", """SELECT d.deployment_id FROM product_deployment d
          JOIN subscription_contract c USING(contract_id)
          WHERE NOT EXISTS (SELECT 1 FROM v_product_use_cases u WHERE u.deployment_id = d.deployment_id
            AND u.product_line = c.product AND u.buying_group_id = c.buying_group_id)"""),
        ("Unmapped scoped value evidence", """SELECT m.measurement_id FROM value_measurement m
          WHERE NOT EXISTS (SELECT 1 FROM v_event_observations o JOIN cs_product_use_case u USING(use_case_id)
            WHERE o.event_id = m.event_id AND u.deployment_id = m.deployment_id)"""),
        ("Qualification signal lacks scoped provenance", """SELECT s.signal_id FROM qualification_signal s
          WHERE NOT EXISTS (SELECT 1 FROM v_event_observations o JOIN cs_product_use_case u USING(use_case_id)
            WHERE o.qualification_signal_id = s.signal_id AND o.event_id = s.event_id AND o.observation_kind = s.signal_kind
              AND (u.deployment_id = s.deployment_id OR u.buying_group_id = s.target_group_id)
              AND (s.signal_kind NOT IN ('discovery_request','rollout_blocker')
                OR (o.evidence_role = 'qualifying_evidence' AND o.source_kind = 'first_party')))"""),
    )
    errors = [(label, row[0]) for label, query in checks for row in db.execute(query)]
    if errors:
        raise ValueError(errors)

def main():
    load_fixture()
    load_workstreams()
    load_product_grounding()
    load_expansion_research()
    plan = load_plan()
    with tempfile.TemporaryDirectory(dir=HERE) as temporary:
        built = Path(temporary) / "canonical.sqlite3"
        with sqlite3.connect(built) as db:
            db.execute("PRAGMA foreign_keys = ON")
            db.executescript("\n".join((SCHEMA, ACCOUNT_METRICS_SCHEMA, CUSTOMER_ACTIONS_SCHEMA, CUSTOMER_LIFECYCLE_SCHEMA,
                                         PRODUCT_GROUNDING_SCHEMA, EXPANSION_RESEARCH_SCHEMA, OUTREACH_SCHEMA)))
            for table, rows in plan:
                if rows:
                    slots = ",".join("?" for _ in rows[0])
                    db.executemany(f"INSERT INTO {table} VALUES ({slots})", rows)
            errors = db.execute("PRAGMA foreign_key_check").fetchall()
            if errors:
                raise ValueError(errors)
            validate_product_grounding(db)
            deploy_seed(plan, db)
        built.replace(HERE / "canonical.sqlite3")
    deploy_migration()
    print("Built fictional SQLite snapshot and replayable seed.")

if __name__ == "__main__":
    main()
