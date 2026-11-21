import {RequestError} from "../src/service.mjs";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fields = {
  create:["draft_id","account_id","person_id","subject","body"],
  edit:["draft_id","expected_revision","subject","body"],
  approve:["draft_id","expected_revision"],
  queue:["draft_id","expected_revision"],
};

function validate(action,args) {
  const names = Object.hasOwn(fields,action) ? fields[action] : null;
  if (!names || !args || typeof args !== "object" || Array.isArray(args) ||
      Object.keys(args).length !== names.length || !names.every(name=>Object.hasOwn(args,name)) ||
      typeof args.draft_id !== "string" || !uuid.test(args.draft_id)) throw new RequestError("Invalid draft operation.");
  if (action !== "create" && (!Number.isSafeInteger(args.expected_revision) || args.expected_revision < 1 || args.expected_revision > 2147483646)) {
    throw new RequestError("Use the current saved draft revision.");
  }
  if (action === "create" && ![args.account_id,args.person_id].every(id=>typeof id === "string" && /^[a-zA-Z0-9]{1,30}$/.test(id))) {
    throw new RequestError("Select a current Salesforce contact.");
  }
  if (action === "create" || action === "edit") {
    const {subject,body} = args;
    if (typeof subject !== "string" || !subject.trim() || subject.length > 240 || /[\r\n\u0000]/.test(subject) ||
        typeof body !== "string" || !body.trim() || body.length > 8000 || body.includes("\u0000")) {
      throw new RequestError("Enter a single-line subject and a message body.");
    }
    if (subject.includes("{{") || body.includes("{{")) throw new RequestError("Resolve template placeholders before saving the copy.");
  }
}

export function createPilotOutreach(pool,userId,provider,readAccount) {
  const visibleDrafts = `FROM cs_pilot.outreach_draft d JOIN cs_pilot.account a USING(account_id)
    JOIN cs_pilot.account_access x ON x.account_id=a.account_id
    LEFT JOIN cs_pilot.gong_handoff h USING(draft_id) WHERE x.user_id=$1 AND a.active`;
  const unavailable = () => new RequestError("This draft is unavailable to your signed-in user.");
  const changed = () => new RequestError("The draft changed. Refresh it and review the current copy.");
  const sentStatus = "CASE WHEN h.status IS NOT NULL THEN h.status WHEN d.approved_at IS NULL THEN 'draft' ELSE 'approved' END";

  async function getOutreachDraft({draft_id}) {
    if (typeof draft_id !== "string" || !uuid.test(draft_id)) throw unavailable();
    const {rows:[row]} = await pool.query(`SELECT d.*, ${sentStatus} AS status,
       h.delivery_mode,h.flow_id,h.owner_email,h.flow_instance_id,h.request_id,h.attempted_at,h.finished_at
       ${visibleDrafts} AND d.draft_id=$2`,[userId,draft_id]);
    if (!row) throw unavailable();
    const {created_by,...draft} = row;
    return {draft:{...draft,can_edit:created_by === userId},gong_mode:provider.mode};
  }

  async function listOutreachDrafts({account,person=null,limit=20}) {
    const {account:{account_id}} = await readAccount({account});
    const {rows:drafts} = await pool.query(`SELECT d.draft_id,d.account_id,d.person_id,d.recipient_name,d.subject,d.revision,
      ${sentStatus} AS status,d.edited_at,h.delivery_mode,h.flow_instance_id ${visibleDrafts}
      AND a.account_id=$2 AND ($3::text IS NULL OR d.person_id=$3 OR lower(d.recipient_name)=lower($3))
      ORDER BY d.edited_at DESC,d.draft_id LIMIT $4`,[userId,account_id,person,limit]);
    return {account_id,drafts,gong_mode:provider.mode};
  }

  async function writeDraft(action,args) {
    validate(action,args);
    const {draft_id,expected_revision,subject,body} = args;
    if (action === "create") {
      const {account_id,person_id} = args;
      await pool.query(`INSERT INTO cs_pilot.outreach_draft (draft_id,account_id,person_id,recipient_name,subject,body,created_by)
        SELECT $2,a.account_id,c.person_id,c.full_name,$5,$6,$1 FROM cs_pilot.account a
        JOIN cs_pilot.account_access x USING(account_id) JOIN cs_pilot.contact c USING(account_id)
        WHERE a.active AND x.user_id=$1 AND a.account_id=$3 AND c.person_id=$4 ON CONFLICT (draft_id) DO NOTHING`,
      [userId,draft_id,account_id,person_id,subject,body]);
      const result = await getOutreachDraft({draft_id});
      if (!result.draft.can_edit || result.draft.account_id !== account_id || result.draft.person_id !== person_id) throw unavailable();
      return result;
    }
    const {draft} = await getOutreachDraft({draft_id});
    if (!draft.can_edit) throw unavailable();
    if (action === "queue" && draft.delivery_mode) return {draft,gong_mode:provider.mode};
    if (draft.revision !== expected_revision) throw changed();
    if (action === "queue") return queue(draft);
    const update = action === "edit" ? "subject=$4,body=$5" : "approved_at=now()";
    const {rows} = await pool.query(`UPDATE cs_pilot.outreach_draft d SET ${update},revision=d.revision+1,edited_at=now()
      FROM cs_pilot.account a, cs_pilot.account_access x
      WHERE d.draft_id=$2 AND d.revision=$3 AND d.approved_at IS NULL AND d.created_by=$1
        AND a.account_id=d.account_id AND a.active AND x.account_id=d.account_id AND x.user_id=$1 RETURNING d.draft_id`,
    [userId,draft_id,expected_revision,...(action === "edit" ? [subject,body] : [])]);
    if (!rows.length) throw changed();
    return getOutreachDraft({draft_id});
  }

  async function queue(draft) {
    if (!draft.approved_at) throw new RequestError("Approve the saved copy before queueing it in Gong.");
    if (provider.mode === "disabled") throw new RequestError("Gong queueing is disabled for this deployment.");
    const task = provider.prepare(draft,userId);
    const {rows} = await pool.query(`INSERT INTO cs_pilot.gong_handoff
        (draft_id,approved_revision,delivery_mode,person_id,flow_id,owner_email,status)
      SELECT d.draft_id,d.revision,$4,d.person_id,$5,$6,'processing' FROM cs_pilot.outreach_draft d
      JOIN cs_pilot.account a USING(account_id)
      JOIN cs_pilot.account_access x ON x.account_id=d.account_id AND x.user_id=$1
      JOIN cs_pilot.contact c ON c.account_id=d.account_id AND c.person_id=d.person_id
      WHERE d.draft_id=$2 AND d.revision=$3 AND d.approved_at IS NOT NULL AND d.created_by=$1 AND a.active
      ON CONFLICT DO NOTHING RETURNING draft_id`,[userId,draft.draft_id,draft.revision,provider.mode,task.flowId,task.ownerEmail]);
    if (!rows.length) {
      const existing = await getOutreachDraft({draft_id:draft.draft_id});
      if (existing.draft.delivery_mode) return existing;
      throw new RequestError("The contact is unavailable or this Gong flow already has a pilot attempt for them.");
    }

    // Reserve the handoff before making the network call. Ambiguous outcomes require reconciliation in Gong.
    let outcome;
    try { outcome = await provider.assign(task); }
    catch { outcome = {status:"review_required",instanceId:null,requestId:null}; }
    await pool.query(`UPDATE cs_pilot.gong_handoff SET status=$2,flow_instance_id=$3,request_id=$4,finished_at=now()
      WHERE draft_id=$1 AND status='processing'`,[draft.draft_id,outcome.status,outcome.instanceId,outcome.requestId]);
    return getOutreachDraft({draft_id:draft.draft_id});
  }

  return {getOutreachDraft,listOutreachDrafts,writeDraft};
}
