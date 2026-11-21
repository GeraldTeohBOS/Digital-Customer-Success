const gongPanel = document.querySelector("#gong-outreach");
const gongEditor = document.querySelector("#gong-editor");
const gongNotice = document.querySelector("#gong-notice");
const gongError = document.querySelector("#gong-error");
const gongMode = document.body.dataset.gongMode;
const draftStatus = {draft:"Draft",approved:"Approved",processing:"Pending Gong confirmation",
  queued:"Manual task queued",rejected:"Assignment rejected",review_required:"Check Gong before retrying"};
document.querySelector("#gong-mode").textContent =
  ({simulated:"Gong simulation",live:"Live Gong pilot",disabled:"Gong queueing disabled"})[gongMode];

let draftScope;
let openDraft;
let draftList = [];
let requestId;
let busy;
let viewVersion = 0;

const button = (label,op,primary = false) =>
  '<button class="action' + (primary ? ' primary' : '') + '" type="button" data-gong-op="' + op + '">' + label + '</button>';
const optionHtml = (value,label,selected) => '<option value="' + esc(value) + '"' + (selected ? " selected" : "") + '>' + esc(label) + '</option>';

function updateNotice(text = "",error = false) {
  gongNotice.textContent = error ? "" : text;
  gongError.textContent = error ? text : "";
  gongError.hidden = !error;
}

function loadEditor() {
  const draft = openDraft;
  const canCreate = draftScope.permissions.includes("outreach.draft");
  const chooser = '<label class="field">Saved drafts <select id="gong-draft-id">' +
    optionHtml("",canCreate ? "New draft" : "Select a draft",!draft) +
    draftList.map(row => optionHtml(row.draft_id,row.recipient_name + " · " + row.subject,row.draft_id === draft?.draft_id)).join("") +
    '</select></label>';
  if (!draft && !canCreate) {
    gongEditor.innerHTML = '<div class="workflow-switch">' + chooser + button("Refresh drafts","refresh") + '</div>';
    return;
  }
  if (!draft && !draftScope.contacts.length) {
    gongEditor.innerHTML = '<div class="workflow-switch">' + chooser + '</div><p class="empty">This account has no current contacts to add to a draft.</p>';
    return;
  }
  const readonly = draft && !draft.can_edit;
  const contactsOptions = draftScope.contacts.map(node=>optionHtml(node.id,node.label,false)).join("");
  const recipient = draft ? '<p class="workflow-muted">To ' + esc(draft.recipient_name) + '</p>' :
    '<label class="field">Contact <select id="gong-contact">' + contactsOptions + '</select></label>';
  const status = draft ? '<span class="status-chip">' + esc(draftStatus[draft.status]) + '</span>' : "";
  const demoCopy = !draft && gongMode === "simulated";
  const subject = draft?.subject ?? (demoCopy ? "Copperline pilot follow-up" : "");
  const body = draft?.body ?? (demoCopy ? "Hi Jo,\n\nCan we review which repositories should be in scope for the pilot?\n\nMorgan" : "");
  const actions = (!draft ? button("Save draft","create",true) : "") +
    (draft?.can_edit ? button("Save edits","edit") : "") +
    (draft?.can_approve ? button("Approve saved copy","approve",true) : "") +
    (draft?.can_queue ? button(gongMode === "simulated" ? "Simulate Gong queue" : "Queue manual Gong task","queue",true) : "");
  const flow = draft?.delivery_mode ?
    '<dl class="message-address"><dt>Gong flow</dt><dd>' + esc(draft.flow_id) + '</dd><dt>Task owner</dt><dd>' +
    esc(draft.owner_email) + '</dd>' + (draft.flow_instance_id ? '<dt>Flow instance</dt><dd><code>' + esc(draft.flow_instance_id) +
      '</code></dd>' : '') + (draft.request_id ? '<dt>Gong request ID</dt><dd><code>' + esc(draft.request_id) + '</code></dd>' : '') + '</dl>' : "";
  const pending = draft && ["processing","review_required"].includes(draft.status);
  gongEditor.innerHTML = '<div class="workflow-switch">' + chooser + button("Refresh drafts","refresh") +
    '</div><div class="workflow-card"><header class="workflow-heading"><h3>Email copy</h3>' + status + '</header>' +
    recipient + '<label class="compose-field">Subject<input id="gong-subject" type="text" maxlength="240" value="' +
    esc(subject) + '"' + (readonly ? ' readonly' : '') + '></label><label class="compose-field">Body<textarea id="gong-body" rows="6" maxlength="8000"' +
    (readonly ? ' readonly' : '') + '>' + esc(body) + '</textarea></label>' + flow +
    (pending ? '<p class="workflow-muted">Check the pilot contact in Gong if this status persists. This attempt stays recorded for review.</p>' : '') +
    '<div class="workflow-actions">' + actions + '</div></div>';
}

async function loadDrafts(id) {
  const version = ++viewVersion;
  const scope = draftScope;
  openDraft = null;
  busy = true;
  gongEditor.innerHTML = '<p class="empty">Loading outreach drafts…</p>';
  try {
    const {drafts} = await call("list_outreach_drafts",{account:scope.accountId});
    const draft = id ? (await call("get_outreach_draft",{draft_id:id})).draft : null;
    if (version !== viewVersion) return;
    draftList = drafts;
    openDraft = draft;
    requestId = crypto.randomUUID();
    loadEditor();
  } catch (error) {
    if (version === viewVersion) {
      updateNotice(error.message,true);
      gongEditor.innerHTML = button("Retry","refresh");
    }
  } finally {
    if (version === viewVersion) busy = false;
  }
}

async function writeDraft(operation) {
  const version = viewVersion;
  const subject = gongEditor.querySelector("#gong-subject")?.value;
  const body = gongEditor.querySelector("#gong-body")?.value;
  const args = operation === "create" ? {draft_id:requestId,account_id:draftScope.accountId,
    person_id:gongEditor.querySelector("#gong-contact").value,subject,body} :
    {draft_id:openDraft.draft_id,expected_revision:openDraft.revision,...(operation === "edit" ? {subject,body} : {})};
  const controls = [...gongEditor.querySelectorAll("button,input,textarea,select")];
  busy = true;
  controls.forEach(input=>{input.disabled = true;});
  updateNotice();
  try {
    const response = await fetch("/api/outreach",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({operation,draft:args})});
    const result = await response.json().catch(()=>({}));
    if (!response.ok) throw new Error(result.error || "The draft could not be updated.");
    if (version !== viewVersion) return;
    openDraft = result.draft;
    draftList = [openDraft,...draftList.filter(row=>row.draft_id!==openDraft.draft_id)];
    loadEditor();
    const label = {create:"Draft saved",edit:"Edits saved",approve:"Copy approved"}[operation] ?? draftStatus[openDraft.status];
    updateNotice(label);
    gongNotice.focus();
  } catch (error) {
    if (version === viewVersion) {
      updateNotice(error.message,true);
      controls.forEach(input=>{input.disabled = false;});
    }
  } finally {
    if (version === viewVersion) busy = false;
  }
}

document.addEventListener("pilot-account",({detail}) => {
  if (!detail?.permissions.includes("outreach.read")) {
    viewVersion++;
    gongPanel.hidden = true;
    gongEditor.replaceChildren();
    draftScope = openDraft = null;
    draftList = [];
    updateNotice();
    return;
  }
  if (draftScope?.accountId === detail.accountId && draftScope.permissions.join() === detail.permissions.join()) {
    draftScope = detail;
    return;
  }
  draftScope = detail;
  gongPanel.hidden = false;
  updateNotice();
  loadDrafts();
});
gongEditor.addEventListener("change",event=>{
  if (event.target.id === "gong-draft-id" && !busy) {
    updateNotice();
    loadDrafts(event.target.value);
  }
});
gongEditor.addEventListener("click",event=>{
  const operation = event.target.closest("button")?.dataset.gongOp;
  if (!operation || busy) return;
  if (operation === "refresh") {
    updateNotice();
    loadDrafts(openDraft?.draft_id);
  } else writeDraft(operation);
});
