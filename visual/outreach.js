let outreachPersonId;
let outreachDraftId;

const outreachStatusLabels = {draft:"Draft",approved:"Approved",queued:"Queued",sent:"Simulated sent",replied:"Simulated reply"};
const outreachRevisionLabels = {generate:"Generated and saved",edit:"Draft updated",approve:"Copy approved",queue:"Queued in Gong simulation",
  send:"Simulated send recorded",reply:"Simulated reply recorded"};
const outreachRouteLabels = {direct_follow_up:"Direct follow-up",warm_intro:"Warm introduction"};
const timeFormat = new Intl.DateTimeFormat("en-US",{dateStyle:"medium",timeStyle:"short"});
const displayTime = value => timeFormat.format(new Date(value));
const workflowAction = (label, operation, primary = false) =>
  '<button class="action' + (primary ? ' primary' : '') + '" type="button" data-outreach-operation="' + operation + '">' + label + '</button>';

function buildOutreach() {
  const people = data.graphs[account].expansion_research.nodes.filter(node => node.outreach_scope);
  const person = people.find(node => node.id === outreachPersonId) ?? people.find(node => node.label === "Jo Mercer") ?? people[0];
  outreachPersonId = person?.id;
  view.innerHTML = '<div class="controls">' + accountPicker() +
    (person ? '<label class="field">Stakeholder <select id="outreach-person">' + people.map(node => option(node.id,node.label,person.id)).join("") + '</select></label>' : '') +
    '</div><section aria-label="Expansion outreach" class="panel outreach-shell"><header class="workflow-heading"><div><h2>Expansion outreach</h2>' +
    (person ? '<p>' + esc(person.label) + ' · ' + esc(data.graphs[account].expansion_research.nodes.find(
      node => node.id === person.outreach_scope.buying_group_id)?.label) + '</p>' : '') +
    '</div><span class="status-chip">' + (liveConsole ? 'Gong simulation' : 'Snapshot') +
    '</span></header><div id="outreach-panel"></div></section>';

  const panel = view.querySelector("#outreach-panel");
  if (!person) {
    panel.innerHTML = '<p class="empty">This account has no researched expansion stakeholders.</p>';
    return;
  }
  if (!liveConsole) {
    const preview = data.outreach_previews[account]?.[person.id];
    if (!preview) return;
    panel.innerHTML = '<div class="workflow-card"><h3>Proposed email</h3><p class="workflow-muted">To ' + esc(preview.recipient) +
      ' · ' + esc(outreachRouteLabels[preview.route]) + '</p><p class="message-subject">' + esc(preview.subject) +
      '</p><p class="message-body">' + esc(preview.body) + '</p><a class="action primary" href="' + esc(data.console_url) +
      '">Open pilot console</a></div>';
    return;
  }
  loadOutreach(panel,person);
}

async function loadOutreach(panel, person) {
  const scope = {account,buying_group:person.outreach_scope.buying_group_id,person:person.outreach_scope.person_id};
  panel.innerHTML = '<p class="empty" role="status">Loading saved drafts…</p>';
  try {
    const {drafts} = await consoleCall("list_outreach_drafts",scope);
    const id = outreachDraftId === "" ? null : drafts.find(item => item.draft_id === outreachDraftId)?.draft_id ?? drafts[0]?.draft_id;
    const result = id ? await consoleCall("get_outreach_draft",{draft_id:id}) : null;
    if (!panel.isConnected) return;
    renderOutreach(panel,scope,person,drafts,result);
  } catch (error) {
    if (!panel.isConnected) return;
    panel.innerHTML = '<div class="workflow-card"><p class="workflow-error" role="alert">' + esc(error.message) +
      '</p><button type="button" class="action" id="reload-outreach">Try again</button></div>';
    panel.querySelector("#reload-outreach").onclick = () => loadOutreach(panel,person);
  }
}

function renderOutreach(panel, scope, person, drafts, result, confirmation = "") {
  const draft = result?.draft;
  const rows = draft ? [draft,...drafts.filter(item => item.draft_id !== draft.draft_id)] : drafts;
  const control = rows.length ? '<label class="field">Saved message <select id="outreach-message">' +
    option("","New draft",draft?.draft_id ?? "") + rows.map(item => option(item.draft_id,
      item.subject + " · " + outreachStatusLabels[item.status],draft?.draft_id)).join("") + '</select></label>' : '';
  panel.innerHTML = '<div class="workflow-switch">' + control + '<p class="workflow-notice" role="status" tabindex="-1">' + esc(confirmation) + '</p></div>' +
    (draft ? savedOutreach(result) : '<div class="workflow-card"><h3>Prepare an email</h3><p class="workflow-muted">Use ' + esc(person.label) +
      '’s engagement and buying-group context to start a draft.</p><label class="field">Approach <select id="outreach-route">' +
      '<option value="">Use recommended approach</option><option value="direct_follow_up">Direct follow-up</option>' +
      '<option value="warm_intro">Warm introduction</option></select></label>' + workflowAction("Generate and save draft","generate",true) + '</div>') +
    '<p class="workflow-error" role="alert" hidden></p>';
  const messageSelector = panel.querySelector("#outreach-message");
  if (messageSelector) messageSelector.onchange = () => { outreachDraftId = messageSelector.value; loadOutreach(panel,person); };

  const requestIds = new Map();
  for (const button of panel.querySelectorAll("[data-outreach-operation]")) {
    button.onclick = async () => {
      const operation = button.dataset.outreachOperation;
      const subject = panel.querySelector("#message-subject")?.value.trim();
      const body = panel.querySelector("#message-body")?.value.trim();
      const reply = panel.querySelector("#reply-body")?.value.trim();
      const includesCopy = ["edit","approve","send"].includes(operation) && (subject !== draft?.subject || body !== draft?.body);
      const error = panel.querySelector(".workflow-error");
      const inputs = [...panel.querySelectorAll("button,select,input,textarea")];
      error.hidden = true;
      if ((includesCopy && (!subject || !body)) || (operation === "reply" && !reply)) {
        error.textContent = operation === "reply" ? "Enter the simulated reply." : "Enter a subject and email body.";
        error.hidden = false;
        return;
      }
      inputs.forEach(input => { input.disabled = true; });
      try {
        let saved;
        if (operation === "generate") {
          const route = panel.querySelector("#outreach-route").value;
          if (!requestIds.has(route)) requestIds.set(route,crypto.randomUUID());
          saved = await consoleCall("save_outreach_draft",{...scope,...(route ? {route} : {}),request_id:requestIds.get(route)});
        } else {
          saved = await consoleCall("update_outreach_draft",{
            draft_id:draft.draft_id, expected_revision:draft.revision, operation,
            ...(includesCopy ? {subject,body} : {}), ...(operation === "reply" ? {body:reply} : {}),
          });
        }
        if (!panel.isConnected) return;
        outreachDraftId = saved.draft.draft_id;
        renderOutreach(panel,scope,person,rows,saved,outreachRevisionLabels[operation]);
        panel.querySelector(".workflow-notice").focus();
      } catch (failure) {
        if (!panel.isConnected) return;
        error.textContent = failure.message;
        error.hidden = false;
        inputs.forEach(input => { input.disabled = false; });
      }
    };
  }
}

function savedOutreach({draft,history,events}) {
  const editable = ["draft","queued"].includes(draft.status);
  const readonly = editable ? "" : " readonly";
  const approved = history.findLast(item => item.operation === "approve");
  const queued = ["queued","sent","replied"].includes(draft.status);
  const evidence = draft.evidence;
  const sources = [...new Set([evidence.history_event_used_in_draft,evidence.discovery_event_id,...evidence.recent_first_party_event_ids].filter(Boolean))];
  const template = {
    draft:workflowAction("Save edits","edit") + workflowAction("Approve copy","approve",true),
    approved:workflowAction("Edit draft","edit") + workflowAction("Queue in Gong","queue",true),
    queued:workflowAction("Simulate send","send",true),
    sent:"",replied:"",
  };
  return '<div class="outreach-layout"><div><section class="workflow-card"><header class="workflow-heading"><h3>Email</h3>' +
    '<span class="status-chip status-' + esc(draft.status) + '">' + esc(outreachStatusLabels[draft.status]) + '</span></header>' +
    '<dl class="message-address"><dt>From</dt><dd>' + esc(draft.sender_name) + '</dd><dt>To</dt><dd>' + esc(draft.recipient_name) +
    ' <span>' + esc(draft.recipient_email) + '</span></dd><dt>Approach</dt><dd>' + esc(outreachRouteLabels[draft.route]) + '</dd></dl>' +
    '<label class="compose-field">Subject<input id="message-subject" maxlength="240" value="' + esc(draft.subject) + '"' + readonly + '></label>' +
    '<label class="compose-field">Body<textarea id="message-body" rows="9" maxlength="8000"' + readonly + '>' + esc(draft.body) + '</textarea></label>' +
    (draft.status === "queued" ? '<p class="workflow-muted">This simulates Morgan’s manual email task in Gong. You can edit the final copy before recording the send.</p>' : '') +
    (template[draft.status] ? '<div class="workflow-actions">' + template[draft.status] + '</div>' : '') + '</section>' +
    (events.length ? '<section class="workflow-card"><h3>Email activity</h3><div class="related">' + events.map(event =>
      '<button type="button" class="edge-link" data-open-event="' + esc(event.event_id) + '"><span>' +
      esc(displayTime(event.occurred_at)) + ' · ' + (event.operation === "send" ? 'Simulated send' : 'Simulated reply') +
      '</span><strong>' + esc(event.title) + '</strong></button>').join("") + '</div>' +
      '<label class="compose-field">Simulated reply<textarea id="reply-body" rows="3" maxlength="8000" placeholder="Enter the customer’s reply for the demo"></textarea></label>' +
      workflowAction("Log simulated reply","reply") + '</section>' : '') + '</div>' +
    '<aside><section class="workflow-card"><h3>Why this outreach</h3>' +
    (draft.why_now ? '<p class="workflow-muted">' + esc(draft.why_now) + '</p>' : '') +
    (draft.workstream_id ? '<p class="workflow-muted">Workstream <code>' + esc(draft.workstream_id) + '</code></p>' : '') +
    '<div class="ref-list evidence-links">' + sources.map(id => '<button class="ref" type="button" data-open-event="' + esc(id) +
      '">' + esc(id) + '</button>').join("") + '</div></section><section class="workflow-card"><h3>Review history</h3><ol class="revision-list">' +
    history.map(item => '<li><strong>' + esc(outreachRevisionLabels[item.operation]) + '</strong><time datetime="' + esc(item.recorded_at) +
      '">' + esc(displayTime(item.recorded_at)) + '</time></li>').join("") + '</ol>' +
    (approved && queued ? '<details class="workflow-details"><summary>Approved copy</summary><p class="message-subject">' + esc(approved.subject) +
      '</p><p class="message-body">' + esc(approved.body) + '</p></details>' : '') +
    (draft.handoff ? '<details class="workflow-details"><summary>Gong handoff details</summary><p class="workflow-muted">' +
      esc(draft.handoff.identity_resolution) + ' · Manual email step</p><p class="workflow-muted"><code>' + esc(draft.handoff.method + ' ' + draft.handoff.path) +
      '</code></p><p class="workflow-muted">Flow instance <code>' + esc(draft.handoff.flow_instance_id) + '</code></p>' +
      '<details><summary>Simulated assignment payload</summary><pre>' + esc(JSON.stringify(draft.handoff,null,2)) + '</pre></details></details>' : '') +
    '</section></aside></div>';
}
