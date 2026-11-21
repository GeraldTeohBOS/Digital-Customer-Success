let timelineEventId;

async function buildTimeline() {
  const accountId = account;
  view.innerHTML = '<div class="controls">' + accountPicker() + '</div><div class="timeline-layout">' +
    '<section class="panel timeline-list" aria-label="Account activity"><h2>Account timeline</h2><div class="timeline-rows">' +
    '<p class="empty" role="status">Loading activity…</p></div></section>' +
    '<section class="panel timeline-detail" aria-label="Event details" aria-live="polite"></section></div>';
  const list = view.querySelector(".timeline-rows");
  try {
    const events = liveConsole ? (await consoleCall("list_timeline",{account:accountId,limit:50})).events :
      data.datasets.v_engagement_timeline.rows.filter(item => item.account_id === accountId);
    if (!list.isConnected) return;
    timelineEventId ??= events[0]?.event_id;
    list.innerHTML = events.length ? events.map(event =>
      '<button class="timeline-row" type="button" data-timeline-event="' + esc(event.event_id) + '" aria-pressed="false">' +
      '<span>' + esc(displayTime(event.occurred_at)) + ' · ' + esc(event.source_name) + '</span><strong>' +
      esc(event.title) + '</strong></button>').join("") : '<p class="empty">No recorded activity for this account.</p>';
    if (timelineEventId) showTimelineEvent(timelineEventId);
  } catch (error) {
    if (list.isConnected) list.innerHTML = '<p class="workflow-error" role="alert">' + esc(error.message) + '</p>';
  }
}

async function showTimelineEvent(id) {
  timelineEventId = id;
  for (const item of view.querySelectorAll("[data-timeline-event]")) {
    item.setAttribute("aria-pressed",String(item.dataset.timelineEvent === id));
  }
  const detail = view.querySelector(".timeline-detail");
  detail.innerHTML = '<p class="empty" role="status">Opening event…</p>';
  try {
    const result = liveConsole ? await consoleCall("get_event",{event_id:id}) : data.event_details[id];
    if (!detail.isConnected || timelineEventId !== id) return;
    if (!result) throw new Error("This event is available in the live console.");
    const {event,groups,messages,observations} = result;
    detail.innerHTML = '<div class="workflow-heading"><div><h2>' + esc(event.title) + '</h2><p>' + esc(displayTime(event.occurred_at)) +
      ' · ' + esc(event.source_name) + '</p></div><span class="status-chip">' + esc(event.source_kind === "simulated" ? "Simulation" : event.event_kind) +
      '</span></div><p class="event-summary">' + esc(event.summary) + '</p>' +
      (groups.length ? '<p class="workflow-muted">' + esc(groups.map(group => group.name).join(", ")) + '</p>' : '') +
      (Object.keys(event.details).length ? '<dl class="message-address event-attributes">' + Object.entries(event.details).map(([label,value]) =>
        '<dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd>').join("") + '</dl>' : '') +
      (messages.length ? '<div class="timeline-thread"><h3>Email thread</h3>' + messages.map(message =>
        '<article><strong>' + esc(message.sender) + '</strong><p class="workflow-muted">' + esc(displayTime(message.sent_at)) +
        (message.recipients.length ? ' · To ' + esc(message.recipients.map(person => person.full_name).join(", ")) : '') +
        '</p><p class="message-body">' + esc(message.body) + '</p></article>').join("") + '</div>' :
        (event.body ? '<p class="message-body">' + esc(event.body) + '</p>' : '')) +
      (observations.length ? '<div class="timeline-thread"><h3>Observations</h3>' + observations.map(observation =>
        '<article><strong>' + esc(observation.product_line + ' · ' + observation.buying_group) +
        '</strong><p class="message-body">' + esc(observation.observed_text) + '</p></article>').join("") + '</div>' : '') +
      (event.draft_id ? '<button class="action" type="button" data-open-draft="' + esc(event.draft_id) + '" data-prospect="' +
        esc(event.prospect_id) + '">Open saved outreach</button>' : '');
  } catch (error) {
    if (detail.isConnected && timelineEventId === id) detail.innerHTML = '<p class="workflow-error" role="alert">' + esc(error.message) + '</p>';
  }
}
