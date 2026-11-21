import { createHistoricalEngagementAgent } from "./engagement-agent.mjs";

const personaLabels = {
  implementation_owner: "Implementation owner",
  technical_evaluator: "Technical evaluator",
  security_reviewer: "Security reviewer",
  potential_sponsor: "Potential sponsor",
};
const rolePriority = {implementation_owner:1, technical_evaluator:1, security_reviewer:2, potential_sponsor:3};
const contribution = {
  implementation_owner:"explain the current setup and own changes during the pilot",
  technical_evaluator:"validate the technical scope and the results we need to collect",
  security_reviewer:"define which findings should reach engineers and how policy exceptions are handled",
  potential_sponsor:"clarify who would sponsor the evaluation and how funding decisions are made",
};

const firstName = name => name.split(/\s+/, 1)[0];

export function createExpansionResearch({all, account, snapshot, RequestError}) {
  const {gatherHistory, developPointOfView} = createHistoricalEngagementAgent(all);

  async function targets({account:reference, buying_group:group} = {}) {
    const accountId = reference ? (await account(reference)).account_id : null;
    const groupReference = group?.trim() ?? null;
    return all(`SELECT * FROM v_expansion_targets WHERE (? IS NULL OR account_id = ?)
      AND (? IS NULL OR buying_group_id = ? OR buying_group = ? COLLATE NOCASE)
      ORDER BY account_name, buying_group`, accountId, accountId, groupReference, groupReference, groupReference);
  }

  async function requireTarget(args) {
    const scopes = await targets(args);
    if (scopes.length !== 1) {
      throw new RequestError("Choose one supported expansion buying group. Use research_expansion_buying_group to see available scopes.");
    }
    return scopes[0];
  }

  async function researchPeople(target) {
    const id = target.buying_group_id;
    const [members, enriched, signalRows] = await Promise.all([
      all(`SELECT g.person_id, p.full_name, p.job_title, p.email, g.buyer_role, g.is_economic_buyer
        FROM group_membership g JOIN person p USING(person_id) WHERE g.buying_group_id = ?
        ORDER BY g.is_economic_buyer, p.full_name`, id),
      all("SELECT * FROM v_clay_candidate_match WHERE buying_group_id = ? ORDER BY name", id),
      all(`SELECT s.* FROM sumble_org_signal s CROSS JOIN dataset_version v WHERE s.buying_group_id = ?
        AND julianday(s.observed_at) BETWEEN julianday(v.as_of_utc)-45 AND julianday(v.as_of_utc)
        ORDER BY s.observed_at DESC, s.signal_id`, id),
    ]);
    const signals = signalRows.map(({technologies_json,...row}) => ({...row, technologies:JSON.parse(technologies_json)}));
    const currentSignals = new Set(signals.map(signal => signal.signal_id));
    const eligible = enriched.filter(row => row.resolution_status === "eligible" && currentSignals.has(row.primary_signal_id));
    const evidence = row => ({provider:"Clay", enrichment_id:row.enrichment_id, source_ref:row.provider_record_ref,
      profile_url:row.profile_url, observed_at:row.observed_at, work_email_state:row.email_state, signal_id:row.primary_signal_id});
    const known = members.map(row => {
      const match = eligible.find(entry => entry.crm_person_id === row.person_id);
      return {candidate_id:row.person_id, name:row.full_name, title:row.job_title, work_email:row.email,
        crm_person_id:row.person_id, crm_status:"in_crm", documented_role:row.buyer_role,
        confirmed_economic_buyer:Boolean(row.is_economic_buyer), marketing_lead_id:match?.lead_id ?? null,
        ...(match ? {clay_evidence:evidence(match)} : {})};
    });
    const prospects = eligible.filter(row => row.crm_status === "no_match_in_demo_crm").map(row => ({
      candidate_id:row.enrichment_id, name:row.name, title:row.job_title, work_email:row.work_email,
      crm_person_id:null, crm_status:row.crm_status, marketing_lead_id:row.lead_id,
      persona_hypothesis:personaLabels[row.persona_hypothesis], persona_key:row.persona_hypothesis,
      reason_to_include:row.responsibility_basis, confirmed_economic_buyer:false, clay_evidence:evidence(row),
    }));
    const review = enriched.filter(row => !eligible.includes(row)).map(row => ({
      candidate_id:row.enrichment_id, name:row.name, title:row.job_title,
      reason:row.resolution_status === "eligible" ? "check_signal_freshness" : row.resolution_status,
      evidence_id:row.enrichment_id,
    }));
    return {known, prospects, review, signals};
  }

  function findPerson(people, reference) {
    const value = reference.trim().toLowerCase();
    const matches = people.filter(item => item.candidate_id.toLowerCase() === value || item.name.toLowerCase() === value);
    if (matches.length !== 1) throw new RequestError("Choose a contact or eligible prospect from the selected buying group.");
    return matches[0];
  }

  async function researchExpansionBuyingGroup(args) {
    const [version, scopes] = await Promise.all([snapshot(), targets(args)]);
    if (scopes.length !== 1) {
      return {snapshot:version, provider_mode:"simulated", available_targets:scopes};
    }
    const target = scopes[0];
    const {known, prospects, review, signals} = await researchPeople(target);
    const histories = await gatherHistory(target, prospects);
    const recommendations = prospects.map(person => {
      const history = histories.find(entry => entry.candidate_id === person.candidate_id);
      return {...person, first_party_touch_count:history.touch_count,
        first_party_context:history.most_substantive_touch ? {
          event_id:history.most_substantive_touch.event_id, title:history.most_substantive_touch.title,
          type:history.most_substantive_touch.touch_type,
        } : null,
        suggested_introduction_via:target.introduction_owner,
      };
    }).sort((a,b) => rolePriority[a.persona_key] - rolePriority[b.persona_key] ||
      Number(Boolean(b.first_party_context)) - Number(Boolean(a.first_party_context)) || a.name.localeCompare(b.name));
    return {
      snapshot:version, provider_mode:"simulated", target, sumble_signals:signals, known_buying_group:known,
      prospects:recommendations.map((person,index) => ({rank:index+1,...person})), identity_review:review,
      ranking_basis:"Pilot implementation and evaluation roles first, then security review and sponsorship. Within a role tier, use exact first-party history to break ties.",
    };
  }

  async function getExpansionEngagementHistory(args) {
    const target = await requireTarget(args);
    const {known, prospects, signals} = await researchPeople(target);
    const people = [...known,...prospects];
    const selected = args.person ? [findPerson(people,args.person)] : people;
    const [version, history] = await Promise.all([snapshot(), developPointOfView(target,selected,signals)]);
    return {
      snapshot:version, agent:"Historical engagement", account_id:target.account_id, buying_group_id:target.buying_group_id,
      synthesis_method:"evidence_rules",
      histories:history, signal_use:"A webinar registration or download indicates engagement with a topic. A separately documented customer request supports discovery.",
    };
  }

  async function draftExpansionOutreach(args) {
    const research = await researchExpansionBuyingGroup(args);
    const target = research.target;
    if (!target) throw new RequestError("Choose one expansion buying group before drafting outreach.");
    const person = args.person ? findPerson([...research.known_buying_group,...research.prospects], args.person) : research.prospects[0];
    if (!person) throw new RequestError("Choose a recipient from the researched buying group.");
    const [history] = await developPointOfView(target,[person],research.sumble_signals);
    const pointOfView = history.point_of_view;
    const conversation = pointOfView?.csm_conversation;
    const reference = await all(`SELECT m.period_role, m.metric_name, m.value, m.unit, m.measurement_scope, m.event_id
      FROM value_measurement m JOIN product_deployment d USING(deployment_id)
      JOIN subscription_contract c USING(contract_id) WHERE c.account_id = ? AND c.buying_group_id = ?
      ORDER BY m.metric_name, m.period_role`, target.account_id, target.incumbent_buying_group_id);

    const route = args.route ?? conversation?.recommended_route ?? "warm_intro";
    const direct = route === "direct_follow_up" || person.candidate_id === target.introduction_owner_id;
    const discovery = target.discovery_stage === "discovery_requested";
    const recipientPerson = direct ? person : research.known_buying_group.find(member => member.candidate_id === target.introduction_owner_id);
    if (!recipientPerson) throw new RequestError("The introduction owner could not be resolved.");
    const recipient = recipientPerson.name;
    const anchor = history.touches.find(row => row.event_id === conversation?.opener_event_id);
    const subject = direct ? (anchor ? `Following up on your ${target.capability_name} question` : `${target.buying_group} evaluation`) :
      `Introduction to ${person.name} for the ${target.buying_group} evaluation`;
    const sessionHook = anchor ? `Thanks for your question in our session on ${anchor.title.charAt(0).toLowerCase()+anchor.title.slice(1)}. ${conversation.opening_question}` : null;
    const introAsk = `Could you introduce me to ${person.name} if they’re the right person to ${contribution[person.persona_key] ?? "help scope the evaluation"}?`;
    const introOwnerHook = discovery && person.candidate_id === target.introduction_owner_id ?
      `Thanks for suggesting an evaluation with ${target.buying_group}. I’d like to get the right owners together for the next discussion.` : null;
    const introContext = discovery ? `Thanks for raising the ${target.buying_group} evaluation.` :
      `I’m exploring whether ${target.capability_name} would be relevant for ${target.buying_group}.`;
    const opening = direct ? sessionHook ?? introOwnerHook ?? `I’m reaching out about the proposed ${target.product_line} evaluation for ${target.buying_group}.` :
      `${introContext} ${introAsk}`;
    const evaluationContext = discovery && anchor ? `${firstName(target.introduction_owner)} and I have been discussing what to test for ${target.buying_group}. ` : "";
    const next = conversation ? (direct ?
      `${evaluationContext}Would you have 20 minutes for a 1:1 to ${conversation.agenda}? ${conversation.value_to_stakeholder}` :
      `I’d like to start with a short 1:1 with ${firstName(person.name)} to ${conversation.agenda}.`) :
      `Would you be open to 20 minutes to ${target.proposed_discussion}?`;
    const scope = target.entity_relationship === "subsidiary" ?
      "I’ll confirm the subsidiary and agreement scope with our account team before we discuss rollout." :
      `If useful, I can bring a relevant example from the ${target.incumbent_buying_group} rollout for context.`;
    const used = direct ? (anchor?.event_id ?? (introOwnerHook ? target.introduction_event_id : null)) : null;
    return {
      mode:"simulated_draft", account:target.account_name, target_entity:target.entity_name,
      target_buying_group:target.buying_group, product:target.product_line, capability:target.capability_name,
      prospect:person.name, route:direct ? "direct_follow_up" : "warm_intro", recipient, subject,
      body:`Hi ${firstName(recipient)},\n\n${opening}\n\n${next} ${scope}\n\nThanks,\n${target.csm_name}`,
      scope:{
        account_id:target.account_id, buying_group_id:target.buying_group_id, prospect_id:person.candidate_id,
        recipient_id:recipientPerson.candidate_id, recipient_email:recipientPerson.work_email,
        recipient_person_id:recipientPerson.crm_person_id,
      },
      point_of_view:pointOfView,
      evidence: {
        discovery_event_id:discovery ? target.introduction_event_id : null, clay_enrichment_id:person.clay_evidence?.enrichment_id ?? null,
        sumble_signal_id:person.clay_evidence?.signal_id ?? null, history_event_used_in_draft:used,
        recent_first_party_event_ids:history.touches.map(touch => touch.event_id),
      },
      incumbent_reference:{buying_group:target.incumbent_buying_group, scoped_measurements:reference},
      next_steps:[
        direct ? `Use the 1:1 to validate ${person.name}’s workflow and what they need from the evaluation.` :
          `Confirm ${person.name}’s remit with ${target.introduction_owner} and agree who should join discovery.`,
        `Validate the pilot scope and baseline. ${target.contract_question}`,
        target.economic_buyer ? `Confirm the decision criteria and funding with ${target.economic_buyer}.` :
          "Ask the subsidiary to identify the economic buyer and funding process.",
      ],
    };
  }

  return {researchExpansionBuyingGroup, getExpansionEngagementHistory, draftExpansionOutreach};
}
