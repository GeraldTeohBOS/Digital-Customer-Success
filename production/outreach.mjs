import {RequestError} from "../src/service.mjs";
import {PermissionError,permitted} from "./permissions.mjs";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fields = {
  create:["draft_id","account_id","person_id","subject","body"],
  edit:["draft_id","expected_revision","subject","body"],
  approve:["draft_id","expected_revision"],
  queue:["draft_id","expected_revision"],
};
const actionPermission = {edit:"outreach.draft",approve:"outreach.approve",queue:"outreach.queue"};
const canRead = permitted("a.account_id","$1","outreach.read");
const canDraft = permitted("a.account_id","$1","outreach.draft");
const canApprove = permitted("a.account_id","$1","outreach.approve");
const canQueue = permitted("a.account_id","$1","outreach.queue");

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
    LEFT JOIN cs_pilot.gong_handoff h USING(draft_id) WHERE a.active AND ${canRead}`;
  const unavailable = () => new PermissionError("This draft is unavailable to your signed-in user.");
  const changed = () => new RequestError("The draft changed. Refresh it and review the current copy.");
  const approved = "d.approved_by IS NOT NULL AND d.approved_by<>d.created_by AND d.approved_at IS NOT NULL";
  const sentStatus = `CASE WHEN h.status IS NOT NULL THEN h.status WHEN ${approved} THEN 'approved' ELSE 'draft' END`;

  async function readDraft(draft_id) {
    if (typeof draft_id !== "string" || !uuid.test(draft_id)) throw unavailable();
    const {rows:[row]} = await pool.query(`SELECT d.draft_id,d.account_id,d.person_id,d.recipient_name,d.subject,d.body,d.revision,
       d.created_by,d.edited_at,d.approved_at,${sentStatus} AS status,
       ${canDraft} AS may_edit,${canApprove} AS may_approve,${canQueue} AS may_queue,
       h.delivery_mode,h.flow_id,h.owner_email,h.flow_instance_id,h.request_id,h.attempted_at,h.finished_at
       ${visibleDrafts} AND d.draft_id=$2`,[userId,draft_id]);
    if (!row) throw unavailable();
    return row;
  }

  async function getOutreachDraft({draft_id}) {
    const {created_by,may_edit,may_approve,may_queue,...draft} = await readDraft(draft_id);
    return {draft:{...draft,
      can_edit:draft.status === "draft" && may_edit && created_by === userId,
      can_approve:draft.status === "draft" && may_approve && created_by !== userId,
      can_queue:draft.status === "approved" && may_queue && Boolean(provider.canAssign?.(draft,userId)),
    },gong_mode:provider.mode};
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
      await pool.query(`WITH created AS (
        INSERT INTO cs_pilot.outreach_draft (draft_id,account_id,person_id,recipient_name,subject,body,created_by)
        SELECT $2,a.account_id,c.person_id,c.full_name,$5,$6,$1 FROM cs_pilot.account a JOIN cs_pilot.contact c USING(account_id)
        WHERE a.active AND ${canDraft} AND a.account_id=$3 AND c.person_id=$4 ON CONFLICT (draft_id) DO NOTHING
        RETURNING account_id,draft_id,revision
      )
      INSERT INTO cs_pilot.authorization_audit (account_id,actor_id,action,draft_id,revision)
      SELECT account_id,$1,'outreach.create',draft_id,revision FROM created`,
      [userId,draft_id,account_id,person_id,subject,body]);
      const draft = await readDraft(draft_id);
      if (!draft.may_edit || draft.created_by !== userId || draft.account_id !== account_id || draft.person_id !== person_id) throw unavailable();
      return getOutreachDraft({draft_id});
    }
    const draft = await readDraft(draft_id);
    if (!draft["may_" + action]) throw new PermissionError("Your role does not allow this outreach action.");
    if (action === "edit" && draft.created_by !== userId) throw new PermissionError("Only the author may edit this draft.");
    if (action === "approve" && draft.created_by === userId) throw new PermissionError("A different user must approve this draft.");
    if (draft.revision !== expected_revision) throw changed();
    if (action === "queue") return draft.delivery_mode ? getOutreachDraft({draft_id}) : queue(draft);
    if (draft.status !== "draft") throw changed();
    const editing = action === "edit";
    const update = editing ? "subject=$5,body=$6" : "approved_at=now(),approved_by=$1";
    const {rows} = await pool.query(`WITH updated AS (
        UPDATE cs_pilot.outreach_draft d SET ${update},revision=d.revision+1,edited_at=now()
        FROM cs_pilot.account a WHERE d.draft_id=$2 AND d.revision=$3 AND NOT COALESCE((${approved}),false)
          AND d.created_by${editing ? "=" : "<>"}$1 AND a.account_id=d.account_id AND a.active
          AND ${permitted("a.account_id","$1",actionPermission[action])}
          AND NOT EXISTS (SELECT 1 FROM cs_pilot.gong_handoff WHERE draft_id=d.draft_id)
        RETURNING d.account_id,d.draft_id,d.revision
      )
      INSERT INTO cs_pilot.authorization_audit (account_id,actor_id,action,draft_id,revision)
      SELECT account_id,$1,$4,draft_id,revision FROM updated RETURNING audit_id`,
    [userId,draft_id,expected_revision,"outreach." + action,...(editing ? [subject,body] : [])]);
    if (!rows.length) throw changed();
    return getOutreachDraft({draft_id});
  }

  async function queue(draft) {
    if (draft.status !== "approved") throw new RequestError("A different user must approve the saved copy before queueing it in Gong.");
    if (provider.mode === "disabled") throw new RequestError("Gong queueing is disabled for this deployment.");
    const task = provider.prepare(draft,userId);
    const {rows} = await pool.query(`WITH reserved AS (
        INSERT INTO cs_pilot.gong_handoff (draft_id,approved_revision,delivery_mode,person_id,flow_id,owner_email,status)
        SELECT d.draft_id,d.revision,$4,d.person_id,$5,$6,'processing' FROM cs_pilot.outreach_draft d
        JOIN cs_pilot.account a USING(account_id) JOIN cs_pilot.contact c ON c.account_id=d.account_id AND c.person_id=d.person_id
        WHERE d.draft_id=$2 AND d.revision=$3 AND (${approved}) AND a.active AND ${canQueue}
        ON CONFLICT DO NOTHING RETURNING draft_id,approved_revision
      )
      INSERT INTO cs_pilot.authorization_audit (account_id,actor_id,action,draft_id,revision)
      SELECT d.account_id,$1,'gong.request',r.draft_id,r.approved_revision FROM reserved r
      JOIN cs_pilot.outreach_draft d USING(draft_id) RETURNING audit_id`,
    [userId,draft.draft_id,draft.revision,provider.mode,task.flowId,task.ownerEmail]);
    if (!rows.length) {
      const existing = await readDraft(draft.draft_id);
      if (!existing.may_queue) throw new PermissionError("Your role does not allow this outreach action.");
      if (existing.delivery_mode) return getOutreachDraft({draft_id:draft.draft_id});
      throw new RequestError("The contact is unavailable or this Gong flow already has a pilot attempt for them.");
    }

    // Reserve the handoff before making the network call. Ambiguous outcomes require reconciliation in Gong.
    let outcome;
    try { outcome = await provider.assign(task); }
    catch { outcome = {status:"review_required",instanceId:null,requestId:null}; }
    await pool.query(`WITH updated AS (
      UPDATE cs_pilot.gong_handoff SET status=$2,flow_instance_id=$3,request_id=$4,finished_at=now()
      WHERE draft_id=$1 AND status='processing' RETURNING draft_id,approved_revision,status
    )
    INSERT INTO cs_pilot.authorization_audit (account_id,actor_id,action,draft_id,revision)
    SELECT d.account_id,$5,'gong.' || u.status,u.draft_id,u.approved_revision FROM updated u
    JOIN cs_pilot.outreach_draft d USING(draft_id)`,[draft.draft_id,outcome.status,outcome.instanceId,outcome.requestId,userId]);
    return getOutreachDraft({draft_id:draft.draft_id});
  }

  return {getOutreachDraft,listOutreachDrafts,writeDraft};
}
