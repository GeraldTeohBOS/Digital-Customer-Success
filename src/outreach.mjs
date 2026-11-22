import {emailBodyHtml} from "./email-copy.mjs";

const outreachTransitions = {
  edit: {from:["draft","approved"], to:"draft"},
  approve: {from:["draft"], to:"approved"},
  queue: {from:["approved"], to:"queued"},
  send: {from:["queued"], to:"sent"},
  reply: {from:["sent","replied"], to:"replied"},
};

function simulatedGongAssignment(draft, RequestError) {
  if (!/@[^\s@]+\.example$/i.test(draft.recipient_email)) {
    throw new RequestError("The Gong simulation requires a fictional .example recipient.");
  }
  const matched = draft.recipient_person_id !== null;
  return {
    provider:"Gong Engage", mode:"simulated", method:"POST", path:"/v2/flows/prospects/assign",
    crm_prospect_id:(matched ? "demo-contact:" : "demo-lead:") + draft.recipient_id,
    identity_resolution:matched ? "Matched demo CRM contact" : "Assigned a simulated CRM lead ID",
    flow_id:"demo-expansion-manual", owner_email:draft.sender_email,
    step_type:"manual_email",
    step_override:{step:1,subject:draft.subject,body_html:emailBodyHtml(draft.body)},
    flow_instance_id:"gong-demo:" + draft.draft_id.slice("outreach:".length),
  };
}

export function createOutreachWorkflow({all, first, write, account, snapshot, draftExpansionOutreach, RequestError, gong}) {
  const readDraft = id => first("SELECT * FROM v_outreach_draft_queue WHERE draft_id = ?", id);

  async function listOutreachDrafts({account:reference, buying_group = null, person = null, limit = 20}) {
    const {account_id} = await account(reference);
    const drafts = await all(`SELECT draft_id, account_id, buying_group_id, buying_group, workstream_id, case_id,
        prospect_id, prospect_name, recipient_name, sender_name, route, subject, status, revision, updated_at
      FROM v_outreach_draft_queue WHERE account_id = ?
        AND (? IS NULL OR buying_group_id = ? OR buying_group = ? COLLATE NOCASE)
        AND (? IS NULL OR prospect_id = ? OR prospect_name = ? COLLATE NOCASE)
      ORDER BY updated_at DESC, draft_id LIMIT ?`,
    account_id, buying_group, buying_group, buying_group, person, person, person, limit);
    return {account_id, drafts, delivery_mode:"simulated"};
  }

  async function getOutreachDraft({draft_id}) {
    const row = await readDraft(draft_id);
    if (!row) throw new RequestError("Outreach draft was not found. Use list_outreach_drafts to find saved drafts.");
    const [updates, events] = await Promise.all([
      all(`SELECT revision, operation, status, subject, body, recorded_at, detail_json
        FROM cs_outreach_revision WHERE draft_id = ? AND revision <= ? ORDER BY revision`, draft_id, row.revision),
      all(`SELECT event_id, title, summary, occurred_at, operation, body FROM v_outreach_timeline
        WHERE draft_id = ? AND revision <= ? ORDER BY revision DESC`, draft_id, row.revision),
    ]);
    const {evidence_json, handoff_json, created_by, ...draft} = row;
    const history = [
      {revision:0, operation:"generate", status:"draft", subject:draft.generated_subject,
        body:draft.generated_body, recorded_at:draft.created_at},
      ...updates.map(({detail_json,...item}) => ({...item, detail:JSON.parse(detail_json)})),
    ];
    return {draft:{...draft, evidence:JSON.parse(evidence_json), handoff:JSON.parse(handoff_json)},
      history, events, delivery_mode:"simulated", ...(gong ? {simulated_gong_flow_id:gong.flowId} : {})};
  }

  async function saveOutreachDraft(args, {actorId} = {}) {
    if (!actorId) throw new RequestError("Sign in to save an outreach draft.");
    const requestId = args.request_id ?? crypto.randomUUID();
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw new RequestError("Invalid draft request ID.");
    const generated = await draftExpansionOutreach(args);
    const scope = generated.scope;
    const draftId = "outreach:" + requestId;
    const [context, version] = await Promise.all([
      first(`SELECT a.csm_id, w.workstream_id, w.case_id FROM account a
        LEFT JOIN cs_workstream w ON w.account_id=a.account_id AND w.buying_group_id=? AND w.job_kind='expansion'
        WHERE a.account_id=? ORDER BY w.workstream_id LIMIT 1`, scope.buying_group_id, scope.account_id),
      snapshot(),
    ]);
    const changed = await write(`INSERT INTO cs_outreach_draft (
        draft_id,account_id,buying_group_id,workstream_id,case_id,prospect_id,prospect_name,
        recipient_id,recipient_name,recipient_email,recipient_person_id,sender_id,route,generated_subject,generated_body,
        source_snapshot_id,why_now,evidence_json,created_by,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(draft_id) DO NOTHING`, [
      draftId, scope.account_id, scope.buying_group_id, context.workstream_id, context.case_id,
      scope.prospect_id, generated.prospect, scope.recipient_id, generated.recipient, scope.recipient_email,
      scope.recipient_person_id, context.csm_id, generated.route, generated.subject, generated.body,
      version.snapshot_id, generated.point_of_view?.why_now?.assessment ?? null, JSON.stringify(generated.evidence),
      actorId, new Date().toISOString(),
    ]);
    if (!changed) {
      const saved = await readDraft(draftId);
      if (saved.account_id !== scope.account_id || saved.buying_group_id !== scope.buying_group_id ||
          saved.prospect_id !== scope.prospect_id || saved.route !== generated.route || saved.created_by !== actorId) {
        throw new RequestError("This request ID belongs to another draft. Use a new request ID.");
      }
    }
    return {...await getOutreachDraft({draft_id:draftId}), replayed:!changed};
  }

  async function updateOutreachDraft(args, {actorId} = {}) {
    if (!actorId) throw new RequestError("Sign in to update an outreach draft.");
    const {draft_id, expected_revision, operation} = args;
    const transition = outreachTransitions[operation];
    const subject = args.subject?.trim() ?? null;
    const body = args.body?.trim() ?? null;
    const hasCopy = subject !== null || body !== null;
    const editsCopy = ["edit","approve","send"].includes(operation);
    if (!transition || (hasCopy && editsCopy && (!subject || !body || /[\r\n]/.test(subject))) ||
        (operation === "reply" && (!body || subject !== null)) || (operation === "queue" && hasCopy)) {
      throw new RequestError("Supply a single-line subject and body when editing copy, or just a body when recording a reply.");
    }
    const intent = JSON.stringify({operation, subject, body});
    const revision = expected_revision + 1;
    const current = await readDraft(draft_id);
    if (!current) throw new RequestError("Outreach draft was not found.");
    let changed = 0;
    if (current.revision === expected_revision && transition.from.includes(current.status)) {
      let detail = {};
      if (operation === "queue") detail = gong ? await gong.assign(current) : simulatedGongAssignment(current,RequestError);
      if (operation === "reply") detail = {reply_body:body};
      changed = await write(`INSERT INTO cs_outreach_revision
        (draft_id,revision,operation,status,subject,body,detail_json,actor_id,recorded_at,intent_json)
        SELECT draft_id,revision+1,?,?,?,?,?,?,?,? FROM v_outreach_draft_queue
        WHERE draft_id=? AND revision=? AND status=? ON CONFLICT(draft_id,revision) DO NOTHING`, [
        operation, transition.to, subject ?? current.subject, editsCopy && body !== null ? body : current.body,
        JSON.stringify(detail), actorId, new Date().toISOString(), intent,
        draft_id, expected_revision, current.status,
      ]);
    }
    if (!changed && !await first(`SELECT 1 FROM cs_outreach_revision
        WHERE draft_id=? AND revision=? AND actor_id=? AND intent_json=?`, draft_id, revision, actorId, intent)) {
      throw new RequestError("The draft changed or this step is out of order. Reopen the draft to see its current status.");
    }
    return {...await getOutreachDraft({draft_id}), recorded_revision:revision, replayed:!changed};
  }

  async function simulateGongHandoff({draft_id, expected_revision, flow_id}, context) {
    if (flow_id !== gong.flowId) throw new RequestError(`Use demo Gong Flow ID ${gong.flowId}.`);
    return updateOutreachDraft({draft_id, expected_revision, operation:"queue"}, context);
  }

  return {listOutreachDrafts, getOutreachDraft,
    ...(write ? {saveOutreachDraft, updateOutreachDraft, ...(gong ? {simulateGongHandoff} : {})} : {})};
}
