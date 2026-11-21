const engagementWeight = {
  authored_email: 4,
  meeting_record: 3,
  webinar_attendance: 2,
  thread_participation: 1,
  webinar_registration: 0,
  content_download: 0,
};

const expansionThemes = {
  reachable_sca: {
    topic: /dependenc|reachab|\bsca\b/i,
    matchesQuestion: question => /shared|reus|workflow|template/i.test(question) && /findings?|results?|ownership|each team/i.test(question),
    leadingClaim: "may be testing whether a shared dependency check can scale across services while findings stay with the teams that own each repository",
    planningClaim: "may be working out how to onboard service teams without duplicating setup across repositories",
    questionMeaning: "The question connects the webinar’s shared scanning workflow with how individual service teams would receive and own findings.",
    checklistMeaning: "The checklist supports a practical rollout hypothesis because it covers ownership, first scans, and how results reach service teams.",
    value: "Endor Open Source uses reachability to help teams prioritize dependency findings that matter in their application context.",
    conversation_value: "I can show how Endor Open Source uses reachability to help each service team decide which dependency findings to fix first.",
    openingQuestion: "It sounded like you’re trying to run one shared dependency check while keeping findings with each repo owner. Is that what you’re looking to validate?",
    discussion: "compare how a team enables its first scan today, agree what results each repo owner should see, and decide if two templates are worth testing",
    success_checks: ["Baseline setup minutes per service team", "Run a successful dependency scan on each selected template", "Check that repo owners can use their own reachability results"],
  },
  container_reachability: {
    topic: /container|image|triage|reachab/i,
    matchesQuestion: question => /image|container|registr/i.test(question) && /finding|triag|priorit|ownership/i.test(question),
    leadingClaim: "may be testing how service teams would prioritize and own findings from their container images",
    planningClaim: "may be exploring how to select images and owners for a small pilot and compare the time spent triaging findings",
    questionMeaning: "The question connects container reachability with the team’s process for deciding which image findings to address.",
    checklistMeaning: "The worksheet helps scope services and build owners and establish a baseline for triage time.",
    value: "Endor Open Source uses container reachability to help teams prioritize image findings with context about what their applications use.",
    conversation_value: "I can show how Endor Open Source uses container reachability to help a service owner prioritize image findings during triage.",
    openingQuestion: "It sounded like you’re looking for a way to prioritize image findings in the context of the services that use them. Is that a problem you’re trying to solve?",
    discussion: "compare how one service team triages image findings today, identify who owns the build, and decide if a three-service evaluation is worth scoping",
    success_checks: ["Identify participating service images and build owners", "Record weekly triage time for the same cohort before the trial", "Review whether reachable image findings are usable in the team's triage workflow"],
  },
};

function buildPointOfView(target, person, history, product, observations, signals) {
  const theme = expansionThemes[product?.capability_id];
  if (!theme) return null;
  const asOf = Date.parse(product.as_of_utc);
  const recentCutoff = asOf - 60 * 86400000;
  const touches = history.touches.filter(row => {
    const at = Date.parse(row.occurred_at);
    return at >= recentCutoff && at <= asOf;
  });
  const content = touches.filter(row => ["webinar_attendance","webinar_registration","content_download"].includes(row.touch_type) &&
    theme.topic.test(row.title + " " + row.summary));
  const question = content.find(row => row.touch_type === "webinar_attendance" && row.attendee_question &&
    theme.matchesQuestion(row.attendee_question));
  const download = content.find(row => row.touch_type === "content_download");
  const colleagues = observations.filter(row => row.sender_id !== person.crm_person_id || row.sender_id === null);
  const request = observations.find(row => row.evidence_role === "qualifying_evidence" && row.event_id === target.introduction_event_id);
  const evaluation = observations.find(row => row.evidence_role === "evaluation_context");
  const initiative = signals.find(row => row.signal_kind === "initiative");
  const stack = signals.find(row => row.signal_kind === "technology");
  const role = person.clay_evidence?.enrichment_id;
  const contactedOwner = person.crm_person_id === target.introduction_owner_id;
  const supportingIds = (...ids) => [...new Set(ids.flat().filter(Boolean))];
  const hypotheses = [];

  if (request?.sender_id && request.sender_id === person.crm_person_id) hypotheses.push({
    id:"documented_evaluation", assessment:"documented",
    claim:request.observed_text, evidence_ids:[request.observation_id],
    validate:"Which owners should help scope the pilot and agree on the success criteria?",
  });
  if (question) hypotheses.push({
    id:"shared_delivery_or_ownership", assessment:request ? "leading" : "plausible",
    claim:`${person.name} ${theme.leadingClaim}.`,
    evidence_ids:supportingIds(question.event_id, request?.observation_id, stack?.signal_id),
    validate:theme.openingQuestion,
  });
  if (download || content.length) hypotheses.push({
    id:"rollout_planning", assessment:question ? "plausible" : "tentative",
    claim:`${person.name} ${theme.planningClaim}.`,
    evidence_ids:supportingIds(download?.event_id ?? content[0].event_id, request?.observation_id, evaluation?.observation_id, role),
    validate:"What is the next implementation decision you need to make, and how do teams handle this today?",
  });
  if (content.length && !contactedOwner) hypotheses.push({
    id:"technical_learning", assessment:"alternative",
    claim:`${person.name} may be building technical context while their involvement in the evaluation is still open.`,
    evidence_ids:content.map(row => row.event_id),
    validate:"Are you exploring the topic, or is there a specific service or template you want to test?",
  });
  if (!hypotheses.length && role) hypotheses.push({
    id:"possible_role_fit", assessment:"unconfirmed",
    claim:`${person.name} may be relevant to the evaluation based on their reported remit.`,
    evidence_ids:supportingIds(role, person.clay_evidence.signal_id),
    validate:`Ask ${target.introduction_owner} to confirm the person’s role and whether there’s a reason to involve them now.`,
  });

  const direct = Boolean(request && (question || contactedOwner));
  const javaAndGo = product.capability_id === "reachable_sca" && question &&
    /\bjava\b/i.test(question.attendee_question) && /\bgo\b/i.test(question.attendee_question);
  const timing = request && question ?
    `${person.name} raised a specific implementation question${download ? " and downloaded an implementation resource" : ""}. ` +
      `${target.introduction_owner} requested a scoped evaluation${evaluation ? " and the team identified what to validate" : ""}. ` +
      "A 1:1 can establish what this stakeholder needs while the pilot scope is still open." : request ?
    `${target.introduction_owner} requested discovery. A warm introduction can confirm this stakeholder’s role and interest while the group chooses the scope.` :
    "The records support exploratory relevance. A 1:1 would help confirm an active initiative and the stakeholder’s involvement.";
  const evidence = {
    stakeholder:content.map(row => ({event_id:row.event_id, occurred_at:row.occurred_at, type:row.touch_type,
      title:row.title, agenda:row.source_text, ...(row.attendee_question ? {question:row.attendee_question} : {})})),
    colleagues,
    company:signals.map(row => ({signal_id:row.signal_id, observed_at:row.observed_at, type:row.signal_kind,
      title:row.title, excerpt:row.source_excerpt, source_url:row.source_url, source_kind:"simulated_third_party"})),
    profile:role ? {enrichment_id:role, reported_remit:person.reason_to_include ?? person.title,
      source_kind:"simulated_third_party"} : null,
  };
  return {
    hypotheses,
    why_these_contents:content.map(row => ({event_id:row.event_id, title:row.title, agenda:row.source_text,
      interpretation:row === question ? theme.questionMeaning : row.touch_type === "content_download" && /owner|onboard|triage/i.test(row.source_text ?? "") ? theme.checklistMeaning :
        "This event shows interest in a topic that matches the proposed evaluation."})),
    why_now:{assessment:timing, initiative_context:initiative?.relevance_hypothesis ?? null,
      evidence_ids:supportingIds(content.map(row=>row.event_id), request?.observation_id, evaluation?.observation_id, initiative?.signal_id)},
    endor_value:{product:product.product_line, capability:product.capability_name, proposition:theme.value,
      reference_url:product.capability_reference_url, test_in_evaluation:theme.success_checks},
    csm_conversation:{recommended_route:direct ? "direct_follow_up" : "warm_intro", format:"one_on_one",
      opener_event_id:question?.event_id ?? null,
      goal:"Validate the stakeholder’s workflow and ownership, then decide whether to propose a scoped expansion pilot with the existing evaluator.",
      opening_question:question ? theme.openingQuestion : hypotheses[0]?.validate ?? null,
      agenda:javaAndGo ? "walk through a Java and a Go template, map who gets the findings today, and agree how to measure setup time" : theme.discussion,
      value_to_stakeholder:theme.conversation_value, existing_evaluator:target.introduction_owner, funding_owner:target.economic_buyer},
    evidence,
  };
}

export function createHistoricalEngagementAgent(all) {
  async function gatherHistory(target, people) {
    const records = await all(`SELECT * FROM v_expansion_first_party_history
      WHERE account_id = ? AND buying_group_id = ? ORDER BY occurred_at DESC, event_id`,
    target.account_id, target.buying_group_id);

    return people.map(person => {
      const matching = records.filter(row =>
        (row.identity_kind === "crm_person" && row.identity_id === person.crm_person_id) ||
        (row.identity_kind === "marketing_lead" && row.identity_id === person.marketing_lead_id));
      const recent = new Map();
      for (const touch of matching) {
        const previous = recent.get(touch.event_id);
        if (!previous || engagementWeight[touch.touch_type] > engagementWeight[previous.touch_type]) {
          recent.set(touch.event_id, touch);
        }
      }
      const touches = [...recent.values()];
      const lead = touches.find(touch => touch.identity_kind === "marketing_lead");
      const strongest = [...touches].sort((a,b) =>
        engagementWeight[b.touch_type] - engagementWeight[a.touch_type])[0];
      const conversation = touches.find(touch => touch.touch_type === "authored_email") ??
        touches.find(touch => touch.touch_type === "webinar_attendance" && touch.attendee_question);
      return {
        candidate_id:person.candidate_id, name:person.name,
        identity_basis: lead ? "Exact work email within the same account and buying group" :
          person.crm_person_id ? "CRM person ID and buying-group membership" : "No first-party identity match in this snapshot",
        most_substantive_touch: strongest ?? null, attributed_conversation: conversation ?? null,
        touch_count:touches.length, touches:touches.slice(0,6),
      };
    });
  }

  async function developPointOfView(target, people, signals) {
    const [history, products, observations] = await Promise.all([
      gatherHistory(target,people),
      all(`SELECT u.capability_id, u.product_line, u.capability_name, u.capability_reference_url, v.as_of_utc
        FROM v_product_use_cases u CROSS JOIN dataset_version v WHERE u.account_id = ? AND u.use_case_id = ?`,
        target.account_id,target.use_case_id),
      all(`SELECT o.observation_id, o.event_id, o.source_message_id, o.observed_at, o.source_id, o.sender_id,
          o.source_sender, o.evidence_role, o.observed_text, o.source_text
        FROM v_event_observations o CROSS JOIN dataset_version v
        WHERE o.account_id = ? AND o.buying_group_id = ? AND o.use_case_id = ? AND o.source_kind = 'first_party'
          AND o.evidence_role IN ('qualifying_evidence','evaluation_context')
          AND julianday(o.observed_at) BETWEEN julianday(v.as_of_utc)-60 AND julianday(v.as_of_utc)
        ORDER BY o.observed_at DESC, o.observation_id`, target.account_id,target.buying_group_id,target.use_case_id),
    ]);
    return history.map((row,index) => ({...row,
      point_of_view:buildPointOfView(target,people[index],row,products[0],observations,signals)}));
  }

  return {gatherHistory, developPointOfView};
}
