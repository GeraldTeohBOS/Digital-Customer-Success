import { createExpansionResearch } from "./expansion.mjs";
import { createOutreachWorkflow } from "./outreach.mjs";

export class RequestError extends Error {}

const percent = value => value === null || value === undefined ? "Unknown" : value + "%";
const isDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;

export function createService(db, ontology, {gong} = {}) {
  const all = (sql, ...parameters) => db.all(sql, parameters);
  const first = async (sql, ...parameters) => (await all(sql, ...parameters))[0];
  const snapshot = () => first("SELECT snapshot_id, as_of_utc, rule_version, dataset_kind FROM dataset_version");
  const expansionResearch = createExpansionResearch({all, account, snapshot, RequestError});
  const outreachAvailable = db.outreach !== false;
  const outreach = outreachAvailable ? createOutreachWorkflow({
    all, first, write:db.write, account, snapshot, draftExpansionOutreach:expansionResearch.draftExpansionOutreach, RequestError, gong,
  }) : {};

  async function account(reference) {
    const result = await first(`SELECT a.* FROM v_account_portfolio a
      WHERE a.account_id = ? OR a.account_name = ? COLLATE NOCASE OR EXISTS (
        SELECT 1 FROM account_alias alias WHERE alias.account_id = a.account_id AND alias.legacy_account_id = ?
      )
      ORDER BY (a.account_id = ?) DESC LIMIT 1`, reference, reference, reference, reference);
    if (!result) throw new RequestError("Account was not found. Use list_accounts for available names and IDs.");
    return result;
  }

  async function listAccounts() {
    const [version, portfolio, deployments] = await Promise.all([
      snapshot(), all("SELECT * FROM v_account_portfolio ORDER BY account_name"),
      all(`SELECT account_id, deployment_id, buying_group_id, adoption_pct, target_pct, adoption_state,
        quality_state, measured_on FROM v_deployment_health ORDER BY deployment_id`),
    ]);
    return {snapshot: version, accounts: portfolio.map(row => ({
      ...row, deployments: deployments.filter(deployment => deployment.account_id === row.account_id),
    }))};
  }

  async function workQueue(playbook, accountId) {
    return all(`SELECT q.*, a.account_name, a.csm_name, a.health_status, a.churn_risk,
        a.licensed_seat_count, a.seat_utilization_pct,
        g.name AS buying_group, d.adoption_pct, d.target_pct, d.change_pp, d.baseline_key,
        x.person_id AS requester_id, x.economic_buyer_id, buyer.full_name AS economic_buyer_name
      FROM v_work_queue q JOIN v_account_portfolio a USING(account_id)
      JOIN buying_group g ON q.buying_group_id = g.buying_group_id
      LEFT JOIN v_deployment_health d ON q.deployment_id = d.deployment_id
      LEFT JOIN v_expansion_discovery x ON q.evidence_signal_id = x.signal_id
      LEFT JOIN person buyer ON x.economic_buyer_id = buyer.person_id
      WHERE (? = 'all' OR q.playbook = ?) AND (? IS NULL OR q.account_id = ?)
      ORDER BY q.next_checkpoint_on IS NULL, q.next_checkpoint_on, q.playbook, a.account_name`,
    playbook, playbook, accountId, accountId);
  }

  function caseGuidance(row) {
    return row.playbook === "stalled_adoption"
      ? "Verify the rollout blocker and next customer commitment with the current deployment owner."
      : "Lead discovery with the prospective group. Agree on its problem, pilot baseline, owner, and decision milestone.";
  }

  function caseWithActions(row, actions) {
    const linked = actions.filter(action => action.case_id === row.case_id);
    return {...row, suggested_next_step:caseGuidance(row), customer_actions:linked};
  }

  async function listWorkQueue({playbook = "all", account: reference} = {}) {
    const scoped = reference ? (await account(reference)).account_id : null;
    const [version, queue, actions] = await Promise.all([snapshot(), workQueue(playbook, scoped), actionQueue(scoped, null, "all")]);
    return {snapshot: version, cases: queue.map(row => caseWithActions(row, actions))};
  }

  async function actionQueue(accountId, jobKind = null, status = "active", limit = 50) {
    return all(`SELECT q.*, u.use_case_id, u.product_line, u.capability_name, u.stage AS product_scope_stage
      FROM v_customer_action_queue q LEFT JOIN cs_workstream_use_case l USING(workstream_id)
      LEFT JOIN v_product_use_cases u USING(use_case_id)
      WHERE (? IS NULL OR q.account_id = ?) AND (? IS NULL OR q.job_kind = ?)
        AND (? = 'all' OR q.status = ? OR (? = 'active' AND q.status <> 'completed'))
      ORDER BY q.status = 'completed', q.due_on, q.status <> 'blocked', q.account_name, q.action_id LIMIT ?`,
    accountId, accountId, jobKind, jobKind, status, status, status, limit);
  }

  async function listCustomerActions({account: reference, job_kind = null, status = "active", limit = 20} = {}) {
    const accountId = reference ? (await account(reference)).account_id : null;
    const [version, actions] = await Promise.all([snapshot(), actionQueue(accountId, job_kind, status, limit)]);
    return {source_snapshot: version, actions};
  }

  async function getCustomerAction({action_id}) {
    const action = await first("SELECT * FROM v_customer_action_queue WHERE action_id = ?", action_id);
    if (!action) throw new RequestError("Action was not found. Use list_customer_actions for current action IDs.");
    const [history, workstream_context, product_context, source_observations] = await Promise.all([
      all(`SELECT * FROM v_customer_action_history WHERE action_id = ? AND revision <= ?
        ORDER BY revision DESC`, action_id, action.revision),
      actionContext(action),
      first(`SELECT u.* FROM cs_workstream_use_case l JOIN v_product_use_cases u USING(use_case_id)
        WHERE l.workstream_id = ?`, action.workstream_id),
      all(`SELECT o.* FROM cs_workstream_use_case l JOIN v_event_observations o USING(use_case_id)
        WHERE l.workstream_id = ? AND o.event_id = ? ORDER BY o.observed_at DESC, o.observation_id`,
        action.workstream_id, action.source_event_id),
    ]);
    return {action, workstream_context, product_context, source_observations, history};
  }

  async function actionContext(action) {
    const id = action.workstream_id;
    switch (action.job_kind) {
      case "first_value":
      case "rollout":
        return first(`SELECT m.*, d.adoption_pct, d.target_pct, d.quality_state, d.snapshot_key AS latest_adoption_snapshot_key
          FROM cs_milestone m JOIN v_deployment_health d USING(deployment_id) WHERE m.workstream_id = ?`, id);
      case "renewal":
        return first(`SELECT r.*, c.renewal_on, p.full_name AS sponsor, base.metric_name,
            base.value AS baseline_value, observed.value AS observed_value, observed.unit,
            observed.measurement_scope, observed.event_id AS value_event_id
          FROM cs_renewal_review r JOIN subscription_contract c USING(contract_id)
          JOIN person p ON p.person_id = r.sponsor_id
          JOIN value_measurement base ON base.measurement_id = r.baseline_measurement_id
          JOIN value_measurement observed ON observed.measurement_id = r.observed_measurement_id
          WHERE r.workstream_id = ?`, id);
      case "risk":
        return first(`SELECT r.*, p.health_status, p.churn_risk, p.assessed_on
          FROM cs_risk_review r JOIN v_account_portfolio p USING(account_id) WHERE r.workstream_id = ?`, id);
      case "expansion": {
        const [review, incumbentAgreements] = await Promise.all([
          first(`SELECT e.*, g.name AS prospective_buying_group, p.full_name AS evaluator,
              buyer.person_id AS economic_buyer_id, buyer.full_name AS economic_buyer, q.stage AS discovery_stage
            FROM cs_expansion_review e JOIN cs_workstream w USING(workstream_id)
            JOIN buying_group g ON g.buying_group_id = w.buying_group_id
            JOIN person p ON p.person_id = e.evaluator_id
            LEFT JOIN v_buying_group_members buyer ON buyer.buying_group_id = g.buying_group_id AND buyer.is_economic_buyer = 1
            LEFT JOIN v_work_queue q ON q.case_id = w.case_id WHERE e.workstream_id = ?`, id),
          all(`SELECT s.*, g.name AS incumbent_buying_group, buyer.full_name AS incumbent_economic_buyer
            FROM v_contract_seat_metrics s JOIN subscription_contract c USING(contract_id)
            JOIN buying_group g ON g.buying_group_id = c.buying_group_id
            LEFT JOIN v_buying_group_members buyer ON buyer.buying_group_id = g.buying_group_id AND buyer.is_economic_buyer = 1
            WHERE s.account_id = ? AND c.status = 'active' AND g.group_kind = 'incumbent' ORDER BY s.contract_id`, action.account_id),
        ]);
        return review ? {...review, incumbent_agreements:incumbentAgreements} : null;
      }
    }
    return null;
  }

  async function recordCustomerAction(args, {actorId} = {}) {
    if (!actorId || !db.write) throw new RequestError("An authenticated editor with action write access is required.");
    const {action_id, expected_revision, status, note, due_on = null, evidence_event_id = null,
      follow_up_title = null, follow_up_on = null} = args;
    if ((follow_up_title === null) !== (follow_up_on === null) || (follow_up_on && status !== "completed")) {
      throw new RequestError("A follow-up requires a title and date on a completed action.");
    }
    if ([due_on, follow_up_on].some(date => date !== null && !isDate(date))) {
      throw new RequestError("Use valid calendar dates in YYYY-MM-DD format.");
    }
    const intent = JSON.stringify({status, note:note.trim(), due_on, evidence_event_id,
      follow_up_title:follow_up_title?.trim() ?? null, follow_up_on});
    const current = await first("SELECT * FROM v_customer_action_queue WHERE action_id = ?", action_id);
    if (!current) throw new RequestError("Action was not found. Use list_customer_actions for current action IDs.");
    if (current.revision === expected_revision && evidence_event_id && !await first(`SELECT 1 FROM v_event_observations o
        JOIN cs_workstream_use_case l USING(use_case_id)
        WHERE o.account_id = ? AND o.event_id = ? AND l.workstream_id = ?`,
        current.account_id, evidence_event_id, current.workstream_id)) {
      throw new RequestError("The evidence event must be mapped to the product use case and buying group of this workstream.");
    }
    const changed = await db.write(`INSERT INTO cs_action_update (
        action_id,account_id,revision,status,due_on,note,evidence_event_id,follow_up_title,
        follow_up_on,follow_up_action_id,actor_id,recorded_at,intent_json
      ) SELECT action_id,account_id,revision+1,?,coalesce(?,due_on),?,?,?,?,?,?,?,?
        FROM v_customer_action_queue WHERE action_id = ? AND revision = ? AND status <> 'completed'`, [
      status, due_on, note.trim(), evidence_event_id, follow_up_title?.trim() ?? null, follow_up_on,
      follow_up_on ? "cs-action:" + crypto.randomUUID() : null, actorId, new Date().toISOString(),
      intent, action_id, expected_revision,
    ]);
    const revision = expected_revision + 1;
    if (!changed && !await first(`SELECT 1 FROM cs_action_update
        WHERE action_id = ? AND revision = ? AND actor_id = ? AND intent_json = ?`, action_id, revision, actorId, intent)) {
      throw new RequestError("The action changed or is already completed. Open it again before recording an update.");
    }
    const result = await getCustomerAction({action_id});
    const recorded = result.history.find(update => update.revision === revision);
    const followUp = recorded.follow_up_action_id ?
      await first("SELECT * FROM v_customer_action_queue WHERE action_id = ?", recorded.follow_up_action_id) : null;
    return {...result, recorded_revision: revision, replayed: !changed, follow_up: followUp};
  }

  async function getAccount({account: reference}) {
    const profile = await account(reference);
    const id = profile.account_id;
    const [version, groups, memberships, deployments, outcomes, seatMetrics, cases, context, actions, useCases, expansionTargets] = await Promise.all([
      snapshot(),
      all("SELECT * FROM buying_group WHERE account_id = ? ORDER BY group_kind, name", id),
      all(`SELECT buying_group_id, person_id, full_name, job_title, org_team, buyer_role, is_economic_buyer
        FROM v_buying_group_members WHERE account_id = ? AND person_id IS NOT NULL
        ORDER BY is_economic_buyer DESC, full_name`, id),
      all("SELECT * FROM v_deployment_health WHERE account_id = ? ORDER BY deployment_id", id),
      all(`SELECT m.* FROM value_measurement m JOIN product_deployment d USING(deployment_id)
        JOIN v_engagement_timeline e USING(event_id) WHERE d.account_id = ?
        ORDER BY m.deployment_id, m.period_role`, id),
      all("SELECT * FROM v_contract_seat_metrics WHERE account_id = ? ORDER BY contract_id", id),
      workQueue("all", id),
      all(`SELECT q.signal_kind, q.target_group_id, q.description, q.event_id, q.observed_at
        FROM qualification_signal q JOIN v_engagement_timeline e USING(event_id)
        CROSS JOIN dataset_version v
        WHERE q.account_id = ? AND (
            (q.signal_kind = 'evaluation_path' AND julianday(q.observed_at) BETWEEN julianday(v.as_of_utc) - 60 AND julianday(v.as_of_utc))
         OR (q.signal_kind = 'market_context' AND julianday(q.observed_at) BETWEEN julianday(v.as_of_utc) - 45 AND julianday(v.as_of_utc))
        ) ORDER BY q.observed_at DESC`, id),
      actionQueue(id, null, "all"),
      all("SELECT * FROM v_product_use_cases WHERE account_id = ? ORDER BY stage, use_case_id", id),
      all(`SELECT buying_group_id, buying_group, entity_name, entity_relationship, introduction_owner,
        economic_buyer, discovery_stage, use_case_id FROM v_expansion_targets WHERE account_id = ? ORDER BY buying_group`, id),
    ]);
    return {
      snapshot: version, account: profile,
      buying_groups: groups.map(group => ({
        ...group, members: memberships.filter(member => member.buying_group_id === group.buying_group_id),
      })),
      deployments: deployments.map(deployment => ({
        ...deployment, value_measurements: outcomes.filter(item => item.deployment_id === deployment.deployment_id),
      })),
      contract_seat_metrics: seatMetrics,
      cases: cases.map(row => caseWithActions(row, actions)),
      context_signals: context,
      customer_actions: actions,
      product_use_cases: useCases,
      expansion_research_targets: expansionTargets,
    };
  }

  async function listTimeline({account: reference, buying_group_id = null, person_id = null, limit = 12, before_utc = null}) {
    const profile = await account(reference);
    const id = profile.account_id;
    if (buying_group_id && !await first("SELECT 1 FROM buying_group WHERE account_id = ? AND buying_group_id = ?", id, buying_group_id)) {
      throw new RequestError("The buying-group ID must belong to this account. See get_account.");
    }
    if (person_id && !await first("SELECT 1 FROM person WHERE account_id = ? AND person_id = ?", id, person_id)) {
      throw new RequestError("The contact ID must belong to this account. See get_account.");
    }
    if (before_utc && !Number.isFinite(Date.parse(before_utc))) {
      throw new RequestError("before_utc must be an ISO 8601 date or timestamp.");
    }
    const [version, events, scopes] = await Promise.all([
      snapshot(),
      all(`SELECT e.*,NULL AS draft_id FROM v_engagement_timeline e WHERE e.account_id = ?
        AND (? IS NULL OR julianday(e.occurred_at) < julianday(?))
        AND (? IS NULL OR EXISTS(SELECT 1 FROM event_buying_group g WHERE g.event_id=e.event_id AND g.buying_group_id=?))
        AND (? IS NULL OR EXISTS(SELECT 1 FROM event_contact c WHERE c.event_id=e.event_id AND c.person_id=?))
        ${outreachAvailable ? `UNION ALL
        SELECT event_id,account_id,occurred_at,event_kind,title,summary,source_record_ref,source_id,source_name,source_kind,draft_id
        FROM v_outreach_timeline WHERE account_id=?
          AND (? IS NULL OR julianday(occurred_at) < julianday(?))
          AND (? IS NULL OR buying_group_id=?)
          AND (? IS NULL OR recipient_person_id=?)` : ""}
        ORDER BY occurred_at DESC, event_id LIMIT ?`,
      id, before_utc, before_utc, buying_group_id, buying_group_id, person_id, person_id,
      ...(outreachAvailable ? [id, before_utc, before_utc, buying_group_id, buying_group_id, person_id, person_id] : []), limit),
      all(`SELECT DISTINCT event_id, use_case_id, buying_group_id, product_line, capability_name, evidence_role
        FROM v_event_observations WHERE account_id = ? AND (? IS NULL OR buying_group_id = ?)
        ${outreachAvailable ? `UNION ALL
        SELECT t.event_id,p.use_case_id,t.buying_group_id,p.product_line,p.capability_name,'simulated_outreach'
        FROM v_outreach_timeline t JOIN v_expansion_targets p USING(buying_group_id)
        WHERE t.account_id=? AND (? IS NULL OR t.buying_group_id=?)` : ""}
        ORDER BY event_id, use_case_id, evidence_role`, id, buying_group_id, buying_group_id,
      ...(outreachAvailable ? [id, buying_group_id, buying_group_id] : [])),
    ]);
    return {snapshot: version, account_id: id, buying_group_id, person_id,
      events:events.map(event => ({...event, product_scopes:scopes.filter(row => row.event_id === event.event_id)}))};
  }

  async function getEvent({event_id}) {
    const source = await first(`SELECT t.*, e.body, e.details_json FROM v_engagement_timeline t
      JOIN engagement_event e USING(event_id) WHERE t.event_id = ?`, event_id);
    if (!source) {
      const logged = outreachAvailable && await first("SELECT * FROM v_outreach_timeline WHERE event_id = ?", event_id);
      if (!logged) throw new RequestError("Event was not found. Use list_timeline to find event IDs.");
      const {operation, recipient_name, recipient_email, sender_name, sender_email, ...entry} = logged;
      const version = await snapshot();
      const {buying_group, use_case_id, product_line, capability_name} = await first(
        "SELECT buying_group, use_case_id, product_line, capability_name FROM v_expansion_targets WHERE buying_group_id = ?",
        entry.buying_group_id,
      );
      const outgoing = operation === "send";
      return {
        snapshot:version,
        event:{...entry, details:{
          From:outgoing ? sender_name + " <" + sender_email + ">" : recipient_name + " <" + recipient_email + ">",
          To:outgoing ? recipient_name + " <" + recipient_email + ">" : sender_name + " <" + sender_email + ">",
          "Draft ID":entry.draft_id, "Product":product_line, "Capability":capability_name,
        }},
        groups:[{buying_group_id:entry.buying_group_id,name:buying_group}], people:[], marketing_leads:[],
        observations:[], messages:[],
        product_scopes:[{use_case_id,buying_group_id:entry.buying_group_id,product_line,capability_name,evidence_role:"simulated_outreach"}],
      };
    }
    const [version, groups, people, messages, recipients, observations, marketing_leads] = await Promise.all([
      snapshot(),
      all(`SELECT g.buying_group_id, g.name FROM event_buying_group j
        JOIN buying_group g USING(buying_group_id) WHERE j.event_id = ? ORDER BY g.name`, event_id),
      all(`SELECT p.person_id, p.full_name, p.job_title FROM event_contact j
        JOIN person p USING(person_id) WHERE j.event_id = ? ORDER BY p.full_name`, event_id),
      all(`SELECT m.message_id, m.sent_at, m.sender_id, p.full_name AS sender, m.body
        FROM email_message m JOIN person p ON m.sender_id = p.person_id
        CROSS JOIN dataset_version v
        WHERE m.event_id = ? AND julianday(m.sent_at) <= julianday(v.as_of_utc)
        ORDER BY m.sent_at DESC, m.message_id`, event_id),
      all(`SELECT r.message_id, p.person_id, p.full_name FROM email_recipient r
        JOIN email_message m USING(message_id) JOIN person p ON r.recipient_id = p.person_id
        WHERE m.event_id = ? ORDER BY r.message_id, p.full_name`, event_id),
      all(`SELECT * FROM v_event_observations WHERE event_id = ? ORDER BY observed_at DESC, observation_id`, event_id),
      all(`SELECT m.lead_id, m.full_name, m.marketing_record_ref, m.buying_group_id FROM event_marketing_lead j
        JOIN cs_marketing_lead m USING(lead_id) WHERE j.event_id = ? ORDER BY m.full_name`, event_id),
    ]);
    const {details_json, ...event} = source;
    return {
      snapshot: version, event: {...event, details: JSON.parse(details_json)}, groups, people, observations, marketing_leads,
      messages: messages.map(message => ({
        ...message,
        observation_ids: observations.filter(item => item.source_message_id === message.message_id).map(item => item.observation_id),
        recipients: recipients.filter(row => row.message_id === message.message_id).map(({person_id, full_name}) => ({person_id, full_name})),
      })),
    };
  }

  async function getAdoptionHistory({account: reference}) {
    const profile = await account(reference);
    return {
      snapshot: await snapshot(), account_id: profile.account_id,
      rows: await all(`SELECT * FROM v_adoption_history WHERE account_id = ?
        ORDER BY deployment_id, measured_on DESC`, profile.account_id),
    };
  }

  async function describeDataset({dataset, limit = 8} = {}) {
    if (!dataset) return {ontology_id: ontology.ontology_id, datasets: ontology.datasets};
    if (!Object.hasOwn(ontology.datasets, dataset)) throw new RequestError("Dataset is not in the canonical catalog.");
    const definition = ontology.datasets[dataset];
    if (definition.live_outreach && !outreachAvailable) throw new RequestError("Use the current kit database to view outreach datasets.");
    const rows = await all(`SELECT * FROM ${dataset} ORDER BY ${definition.order_by} LIMIT ?`, limit);
    const columns = rows.length ? Object.keys(rows[0]) : (await all(`PRAGMA table_info(${dataset})`)).map(column => column.name);
    return {snapshot: await snapshot(), dataset, ...definition, columns, rows};
  }

  async function getOntology({dataset} = {}) {
    if (!dataset) return ontology;
    if (!Object.hasOwn(ontology.datasets, dataset)) throw new RequestError("Dataset is not in the canonical catalog.");
    return {
      dataset, ...ontology.datasets[dataset],
      relationships: ontology.relationships.filter(edge => edge.from_dataset === dataset || edge.to_dataset === dataset),
    };
  }

  async function getKnowledgeGraph({account: reference, mode = "relationships"}) {
    const brief = await getAccount({account: reference});
    const catalog = new Map();
    const edges = new Map();
    const add = (id, type, label, subtitle, lane, fields) => {
      if (!catalog.has(id)) catalog.set(id, {id, type, label, subtitle, lane, fields});
      return id;
    };
    const edge = (from, to, relationship, label) => edges.set(JSON.stringify([from,to,relationship]), {from,to,relationship,label});
    const groupNode = (group, lane) => add(group.buying_group_id, "buying_group", group.name,
      group.group_kind === "prospective" ? "Prospective buying group" : "Incumbent buying group", lane, {
        "Group ID": group.buying_group_id, "Organizational unit": group.org_unit,
        "Objective": group.objective, "Evaluation or contract scope": group.scope_note,
        "Economic buyer": group.members.find(member => member.is_economic_buyer)?.full_name ?? "Unknown",
        "Product use cases": brief.product_use_cases.filter(item => item.buying_group_id === group.buying_group_id)
          .map(item => item.product_line + " · " + item.use_case_name).join("\n") || "Unspecified",
      });
    const deploymentNode = (deployment, lane) => {
      const scope = brief.product_use_cases.find(item => item.deployment_id === deployment.deployment_id);
      return add(deployment.deployment_id, "product_deployment", "Current deployment", deployment.product, lane, {
        "Deployment ID": deployment.deployment_id, "Use case": deployment.use_case,
        "Capability": scope?.capability_name, "Customer problem": scope?.customer_problem,
        "Repository adoption": percent(deployment.adoption_pct),
        "Reporting scope": deployment.coverage_definition,
        "Success measure": scope?.success_measure,
      });
    };
    const sourceEvents = new Map();
    const sourceEvent = async id => {
      if (!sourceEvents.has(id)) sourceEvents.set(id, await getEvent({event_id:id}));
      return sourceEvents.get(id);
    };
    const eventNode = async eventId => {
      if (catalog.has(eventId)) return eventId;
      const event = await sourceEvent(eventId);
      return add(eventId, "engagement_event", event.event.title,
        event.event.source_name + " · " + event.event.occurred_at.slice(0, 10), 0, {
          "Event ID": eventId, "Source summary": event.event.summary, "Original reference": event.event.source_record_ref,
          "Buying groups": event.groups.map(group => group.name).join(", ") || "Unassigned",
          ...(event.marketing_leads.length ? {"Marketing lead":event.marketing_leads.map(lead=>lead.full_name).join(", ")} : {}),
          "Endor product": [...new Set(event.observations.map(item => item.product_line + " · " + item.capability_name))].join("\n"),
          "Scoped observations": event.observations.map(item => item.buying_group + " · " +
            item.evidence_role.replaceAll("_", " ") + "\n" + item.observed_text).join("\n\n"),
        });
    };

    if (mode === "expansion_research") {
      for (const item of brief.expansion_research_targets) {
        const query = {account:brief.account.account_id,buying_group:item.buying_group_id};
        const [research, engagement] = await Promise.all([
          expansionResearch.researchExpansionBuyingGroup(query), expansionResearch.getExpansionEngagementHistory(query),
        ]);
        const {target, known_buying_group: known, prospects, sumble_signals: signals} = research;
        const pointsOfView = new Map(engagement.histories.map(row => [row.candidate_id,row.point_of_view]));
        const targetId = add(target.buying_group_id, "v_expansion_targets", target.buying_group,
          target.entity_relationship.replaceAll("_"," "), 2, {
            "Target entity":target.entity_name, "Entity domain":target.entity_domain, "Incumbent group":target.incumbent_buying_group,
            "Product":target.product_line, "Capability":target.capability_name, "Economic buyer":target.economic_buyer,
            "Scope check":target.contract_question,
          });
        const influences = new Set(prospects.map(person => person.clay_evidence.signal_id));
        for (const signal of signals) {
          add(signal.signal_id,"sumble_org_signal",signal.title,"Simulated Sumble · " + signal.signal_kind.replaceAll("_"," "),0,{
            "Signal ID":signal.signal_id, "Source excerpt":signal.source_excerpt, "Source URL":signal.source_url,
            "Technologies":signal.technologies.join(", "), "Relevance hypothesis":signal.relevance_hypothesis,
          });
          if (!influences.has(signal.signal_id)) edge(signal.signal_id,targetId,"informs_target_scope","Informs scope");
        }
        for (const person of [...known,...prospects]) {
          const external = person.crm_status === "no_match_in_demo_crm";
          const view = pointsOfView.get(person.candidate_id);
          add(person.candidate_id,external ? "clay_person_enrichment" : "person",person.name,
            external ? person.persona_hypothesis : person.documented_role,1,{
              "Title":person.title, "CRM status":external ? "No match in demo CRM" : "Known CRM contact",
              ...(external ? {"Role hypothesis":person.persona_hypothesis, "Reason":person.reason_to_include,
                "Clay record":person.clay_evidence.enrichment_id, "Simulated profile":person.clay_evidence.profile_url,
                "Introduction via":target.introduction_owner} : {"Person ID":person.crm_person_id}),
              ...(view && view.hypotheses.length ? {
                "Intent hypotheses":view.hypotheses.map(row => `${row.claim}\nEvidence · ${row.evidence_ids.join(", ")}`).join("\n\n"),
                ...(view.why_these_contents.length ? {"Why these resources":view.why_these_contents.map(row =>
                  `${row.title}\n${row.interpretation}`).join("\n\n")} : {}),
                "Why now":view.why_now.assessment,
                ...(view.why_now.initiative_context ? {"Company context":view.why_now.initiative_context} : {}),
                "Endor value":view.endor_value.proposition,
                "CSM 1:1":view.csm_conversation.agenda,
                "Recommended approach":view.csm_conversation.recommended_route.replaceAll("_"," "),
              } : {}),
            });
          catalog.get(person.candidate_id).outreach_scope = {buying_group_id:target.buying_group_id,person_id:person.candidate_id};
          edge(person.candidate_id,targetId,external ? "proposed_participant" : "group_member",
            external ? "Proposed participant" : "CRM member");
          if (external) edge(person.clay_evidence.signal_id,person.candidate_id,"supports_role_hypothesis","Supports role hypothesis");
          if (person.first_party_context) {
            edge(await eventNode(person.first_party_context.event_id),person.candidate_id,"matched_first_party_touch","Matched engagement");
          }
        }
        if (target.discovery_stage === "discovery_requested") {
          edge(await eventNode(target.introduction_event_id),target.introduction_owner_id,
            "documented_discovery_request","Documented discovery request");
        }
        const next = add(target.buying_group_id + "/intro", "cs_expansion_target", "Scope the next conversation",
          "Via " + target.introduction_owner,3,{
            "Agenda":target.proposed_discussion, "Existing conversation":target.introduction_event_id, "Stage":target.discovery_stage,
          });
        edge(targetId,next,"plans_introduction","Plans a warm introduction");
      }
    } else if (mode === "relationships") {
      const profile = brief.account;
      const root = add(profile.account_id, "account", profile.account_name, profile.industry, 0, {
        "Account ID": profile.account_id, "CSM": profile.csm_name,
        "Account health": profile.health_status, "Churn risk": profile.churn_risk, "Assessed on": profile.assessed_on,
        "Licensed seats": profile.licensed_seat_count, "Repository adoption": percent(profile.adoption_rate_pct),
        "90-day active contributors": profile.active_contributors_90d, "Seat utilization": percent(profile.seat_utilization_pct),
      });
      for (const group of brief.buying_groups) {
        const groupId = groupNode(group, 1);
        edge(root, groupId, "has_buying_group", "Has buying group");
        for (const member of group.members) {
          const personId = add(member.person_id, "person", member.full_name, member.buyer_role, 2, {
            "Person ID": member.person_id, "Title": member.job_title, "Group role": member.buyer_role,
          });
          edge(groupId, personId, member.is_economic_buyer ? "has_economic_buyer" : "has_member", member.buyer_role);
        }
        for (const deployment of brief.deployments.filter(item => item.buying_group_id === groupId)) {
          const seats = brief.contract_seat_metrics.find(row => row.contract_id === deployment.contract_id);
          const contractId = add(deployment.contract_id, "subscription_contract", "Existing agreement",
            "Renews " + deployment.renewal_on, 2, {
              "Contract ID": deployment.contract_id, "Product": deployment.product,
              "Licensed seats": seats?.licensed_seat_count,
              "90-day active contributors": seats?.active_contributors_90d,
              "Seat utilization": percent(seats?.seat_utilization_pct), "Usage measured on": seats?.measured_on,
            });
          edge(groupId, contractId, "owns_contract", "Owns agreement");
          edge(contractId, deploymentNode(deployment, 3), "covers_deployment", "Covers deployment");
        }
      }
    } else if (mode === "actions") {
      const ownerNode = (id, name, role) => add(id, "person", name, role, 3, {"Person ID":id, "Role":role});
      const jobLabel = {first_value:"First value", rollout:"Rollout", renewal:"Renewal", risk:"Risk intervention", expansion:"Expansion discovery"};
      for (const action of brief.customer_actions) {
        const group = brief.buying_groups.find(item => item.buying_group_id === action.buying_group_id);
        const scope = brief.product_use_cases.find(item => item.use_case_id === action.use_case_id);
        const workstream = add(action.workstream_id, "cs_workstream", action.workstream_title, jobLabel[action.job_kind], 1, {
          "Workstream ID":action.workstream_id, "Buying group":group?.name, "Group ID":action.buying_group_id,
          "Product":scope?.product_line, "Capability":scope?.capability_name, "Customer problem":scope?.customer_problem,
          "Success measure":scope?.success_measure,
          "Customer objective":action.customer_objective, "Source event":action.source_event_id,
        });
        if (action.source_event_id) {
          edge(await eventNode(action.source_event_id), workstream, "supports_workstream", "Source evidence");
        }
        const actionNode = add(action.action_id, "v_customer_action_queue", action.title,
          action.status.replaceAll("_", " ") + " · Due " + action.due_on, 2, {
            "Action ID":action.action_id, "Accountable owner":action.owner_name, "Customer contact":action.customer_contact,
            "Status":action.status.replaceAll("_", " "), "Due date":action.due_on, "Latest note":action.latest_note,
            "Outcome":action.outcome, "Follow-up":action.follow_up_title, "Follow-up due date":action.follow_up_on,
          });
        edge(workstream, actionNode, "has_owned_action", "Has action");
        edge(actionNode, ownerNode(action.owner_id, action.owner_name, "CSM · accountable owner"), "owned_by", "Accountable owner");
        if (action.customer_contact_id) {
          const contact = ownerNode(action.customer_contact_id, action.customer_contact, "Customer contact");
          edge(actionNode, contact, "works_with", "Customer contact");
        }
        if (action.update_evidence_event_id && action.update_evidence_event_id !== action.source_event_id) {
          edge(await eventNode(action.update_evidence_event_id), actionNode, "documents_action_update", "Update evidence");
        }
      }
      for (const action of brief.customer_actions) {
        if (catalog.has(action.follow_up_action_id)) edge(action.action_id, action.follow_up_action_id, "opens_follow_up", "Opens next checkpoint");
      }
    } else {
      for (const item of brief.cases) {
        const target = brief.buying_groups.find(group => group.buying_group_id === item.buying_group_id);
        const decision = add(item.case_id, "v_work_queue",
          item.playbook === "stalled_adoption" ? "Stalled adoption" : "Expansion discovery",
          item.stage.replaceAll("_", " "), 2, {"Case ID": item.case_id, "Why now": item.why_now,
            "Suggested next step": item.suggested_next_step, "Rule": brief.snapshot.rule_version,
            "Owned action": item.customer_actions[0]?.title, "Action ID":item.customer_actions[0]?.action_id});
        edge(decision, groupNode(target, 3), "acts_on_buying_group", "Acts on buying group");
        if (item.evidence_event_id) {
          const source = await eventNode(item.evidence_event_id);
          const event = await sourceEvent(item.evidence_event_id);
          const observation = event.observations.find(row => row.qualification_signal_id === item.evidence_signal_id);
          const signal = add(item.evidence_signal_id, "qualification_signal",
            item.playbook === "stalled_adoption" ? "Recorded rollout blocker" : "Direct request from new group", "First-party evidence", 1, {
              "Signal ID": item.evidence_signal_id, "Observation": item.why_now,
              "Observation ID":observation?.observation_id, "Evidence event":item.evidence_event_id,
              ...(observation?.source_message_id ? {"Message ID":observation.source_message_id, "Sender":observation.source_sender} : {}),
              "Source text":observation?.source_text, "Product":observation?.product_line, "Capability":observation?.capability_name,
              "Use-case scope":observation?.buying_group,
            });
          edge(source, signal, "documents_signal", "Documents observation");
          edge(signal, decision, "justifies_case", "Qualifying evidence");
        }
        if (item.evidence_snapshot_key) {
          const deployment = brief.deployments.find(row => row.deployment_id === item.deployment_id);
          const measure = add(item.evidence_snapshot_key, "adoption_snapshot", deployment.adoption_pct + "% repository coverage",
            deployment.active_repos + " of " + deployment.in_scope_repos + " repositories", 1, {
              "Snapshot": item.evidence_snapshot_key, "Baseline": deployment.baseline_key,
              "Target": deployment.target_pct + "%", "Four-week change": deployment.change_pp + " pp",
            });
          edge(measure, decision, "supports_adoption_case", "Measured stall");
          for (const observation of deployment.value_measurements.filter(row => row.period_role === "observed")) {
            edge(await eventNode(observation.event_id), measure, "deployment_context", "Same deployment context");
          }
        } else {
          for (const context of brief.context_signals.filter(signal => signal.target_group_id === item.buying_group_id)) {
            const source = await eventNode(context.event_id);
            const fact = add("context:" + context.event_id, "qualification_signal",
              context.signal_kind === "market_context" ? "Market context" : "Evaluation path",
              context.signal_kind === "market_context" ? "Third-party context" : "First-party confirmation", 1, {
                "Observation": context.description, "Event ID": context.event_id,
              });
            edge(source, fact, "documents_signal", "Documents observation");
            edge(fact, decision, "context_for_case", "Context for discovery");
          }
          // Value from existing deployments is deliberately labeled as incumbent evidence.
          for (const deployment of brief.deployments) {
            const observation = deployment.value_measurements.find(row => row.period_role === "observed");
            const baseline = deployment.value_measurements.find(row => row.period_role === "baseline");
            if (!observation) continue;
            const owner = brief.buying_groups.find(group => group.buying_group_id === deployment.buying_group_id);
            const value = add(observation.measurement_id, "value_measurement", observation.metric_name,
              (baseline ? baseline.value + " to " : "") + observation.value + " " + observation.unit, 1, {
                "Incumbent group": owner?.name ?? "Unknown", "Deployment ID": deployment.deployment_id,
                "Measured scope": observation.measurement_scope, "Role in decision": "Existing customer evidence for the introduction",
              });
            edge(await eventNode(observation.event_id), value, "reports_value_measurement", "Reports measured value");
            edge(value, decision, "incumbent_context_for_case", "Incumbent proof for introduction");
          }
        }
      }
      if (!catalog.size) {
        const profile = brief.account;
        const source = add(profile.account_id, "account", profile.account_name, "Current account", 0, {"CSM": profile.csm_name});
        for (const deployment of brief.deployments) {
          const scoped = deploymentNode(deployment, 1);
          const state = add(deployment.deployment_id + "/adoption-state", "v_deployment_health", "Adoption status",
            deployment.adoption_state.replaceAll("_", " "), 2, {
              "Coverage": deployment.adoption_pct + "%", "Data quality": deployment.quality_state,
              "Next step": "Continue the agreed rollout and check the next milestone.",
            });
          edge(source, scoped, "has_deployment", "Has existing deployment");
          edge(scoped, state, "derived_deployment_health", "Evaluated using scope and baseline");
        }
      }
    }
    return {
      snapshot: brief.snapshot, account_id: brief.account.account_id, mode,
      nodes: [...catalog.values()], edges: [...edges.values()],
    };
  }

  return {listAccounts, getAccount, listWorkQueue, listTimeline, getEvent, getAdoptionHistory, describeDataset, getOntology,
    getKnowledgeGraph, listCustomerActions, getCustomerAction, ...expansionResearch, ...outreach, ...(db.write ? {recordCustomerAction} : {})};
}
