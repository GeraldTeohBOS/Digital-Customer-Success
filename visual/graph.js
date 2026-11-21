const data = JSON.parse(document.querySelector("#snapshot-data").textContent);
const view = document.querySelector("#view");
const liveConsole = document.body.dataset.liveConsole === "true";
const esc = value => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;",
})[character]);
const modeNames = {relationships:"Buying relationships",evidence:"Decision trace",actions:"Owned actions",expansion_research:"Expansion research"};
const laneNames = {
  relationships:["Account","Buying groups","People and agreements","Deployment"],
  evidence:["Source records","Observed facts","Rule result","Buying group"],
  actions:["Source records","Workstreams","Owned actions","People"],
  expansion_research:["Research and engagement","People","Target buying group","Next conversation"],
};
const typeLabels = {
  account:"Account", buying_group:"Buying group", person:"Person", subscription_contract:"Contract",
  product_deployment:"Deployment", engagement_event:"Evidence event", qualification_signal:"Signal",
  adoption_snapshot:"Adoption snapshot", value_measurement:"Value measurement", v_work_queue:"Work case",
  v_deployment_health:"Deployment health", cs_workstream:"Workstream", v_customer_action_queue:"Owned action",
  v_expansion_targets:"Expansion scope", cs_expansion_target:"Proposed next step", sumble_org_signal:"Sumble signal",
  clay_person_enrichment:"Clay prospect",
};
let active = "graph";
let account = (data.accounts.find(item => item.account_name === "Copperline Cloud") ?? data.accounts[0]).account_id;
let mode = "relationships";
let selected;
let graphObserver;
let dataset = "v_account_portfolio";
let evidenceEvent;
const stamp = new Intl.DateTimeFormat("en-US", {day:"numeric",month:"short",year:"numeric",timeZone:"UTC"});
document.querySelector("#snapshot").textContent = "Snapshot · " + stamp.format(new Date(data.snapshot.as_of_utc));
document.querySelector("#version").textContent = data.snapshot.rule_version + " · " + data.accounts.length + " accounts";

function option(value, label, current) {
  return '<option value="' + esc(value) + '"' + (value === current ? " selected" : "") + '>' + esc(label) + '</option>';
}

function accountPicker() {
  return '<label class="field">Account <select id="account-select">' +
    data.accounts.map(item => option(item.account_id,item.account_name,account)).join("") + '</select></label>';
}

async function consoleCall(name, arguments_) {
  const response = await fetch("/api/console",{
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({jsonrpc:"2.0",id:"console",method:"tools/call",params:{name,arguments:arguments_}}),
  });
  if (!response.ok) throw new Error(response.status === 401 ? "Sign in to the console and try again." : "The console could not load this request. Try again.");
  const {result,error} = await response.json();
  if (error) throw new Error(error.message);
  if (result.isError) throw new Error(result.content[0].text);
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

function accountMetrics(profile) {
  const number = value => value ?? "Unknown";
  const pct = value => value == null ? "Unknown" : value + "%";
  const assessment = profile.assessed_on ? "CSM · " + profile.assessed_on : "CSM assessment";
  const repositoryFootnote = profile.adoption_rate_pct == null ? "See deployment details" :
    profile.repos_scanned_30d + " of " + profile.in_scope_repos + " repos · 30 days";
  const seatFootnote = profile.seat_utilization_pct == null ? "See contract details" :
    profile.active_contributors_90d + " contributors · 90 days";
  const items = [
    ["Account ID", profile.account_id, "Canonical key"],
    ["Account health", number(profile.health_status), assessment],
    ["Churn risk", number(profile.churn_risk), assessment],
    ["Licensed seats", number(profile.licensed_seat_count), "Active contract entitlement"],
    ["Repository adoption", pct(profile.adoption_rate_pct), repositoryFootnote],
    ["Seat utilization", pct(profile.seat_utilization_pct), seatFootnote],
  ];
  return '<dl class="account-metrics" aria-label="Account portfolio metrics">' + items.map(([label,value,detail]) =>
    '<div><dt>' + esc(label) + '</dt><dd>' + esc(value) + '<small>' + esc(detail) + '</small></dd></div>'
  ).join("") + '</dl>';
}

function buildGraph() {
  graphObserver?.disconnect();
  const graph = data.graphs[account][mode];
  const profile = data.accounts.find(item => item.account_id === account);
  const lanes = mode === "evidence" && !graph.nodes.some(node => node.lane === 3) ?
    ["Account","Deployment","Rule result"] : laneNames[mode];
  const groups = lanes.map((label,lane) => ({label, nodes:graph.nodes.filter(node => node.lane === lane)}))
    .filter(group => group.nodes.length);
  if (!graph.nodes.some(node => node.id === selected)) {
    const initialType = {relationships:"account", evidence:"v_work_queue", actions:"v_customer_action_queue",expansion_research:"v_expansion_targets"};
    selected = graph.nodes.find(node => node.type === initialType[mode])?.id ?? graph.nodes[0]?.id;
  }

  const controls = '<div class="controls">' + accountPicker() +
    '<div class="segment" aria-label="Graph view">' + Object.entries(modeNames).map(([key,label]) =>
      '<button type="button" data-mode="' + key + '" aria-pressed="' + (mode === key) + '">' + label + '</button>').join("") + '</div></div>';
  const graphLanes = groups.map(({label,nodes}) => '<section class="map-lane"><h2 class="lane-title">' + esc(label) +
    '</h2><div class="lane-items">' + nodes.map(node => '<button class="node type-' + esc(node.type) +
      '" type="button" data-node="' + esc(node.id) + '" aria-pressed="false"><strong>' + esc(node.label) +
      '</strong><span>' + esc(node.subtitle) + '</span></button>').join("") + '</div></section>').join("");
  view.innerHTML = controls + accountMetrics(profile) +
    '<div class="workspace"><div class="panel"><div class="map" role="region" aria-label="' + esc(modeNames[mode]) + '">' +
    '<svg aria-hidden="true" class="map-svg"><defs><marker id="arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">' +
    '<path d="M0 0 L7 3.5 0 7"/></marker></defs><g class="edge-paths"></g></svg>' +
    '<div class="map-lanes" style="--lane-count:' + Math.max(groups.length,1) + '">' +
    (graphLanes || '<p class="empty">' + (mode === "expansion_research" ? "No expansion research for this account." : "No owned actions in this snapshot.") + '</p>') + '</div></div>' +
    '<div class="legend"><span class="type-buying_group"><i></i>Buying groups</span>' +
    '<span class="type-person"><i></i>People and evidence</span><span class="type-adoption_snapshot"><i></i>Scope and measurement</span>' +
    '<span class="type-v_work_queue"><i></i>Account and decision</span></div></div>' +
    '<aside class="panel details" id="inspector" tabindex="0" aria-label="Selected node details" aria-live="polite"></aside></div>';
  const map = view.querySelector(".map");
  const layout = () => drawEdges(map,graph.edges);
  graphObserver = new ResizeObserver(layout);
  graphObserver.observe(map);
  layout();
  inspect(graph);
}

function drawEdges(map, edges) {
  const bounds = map.getBoundingClientRect();
  const svg = map.querySelector(".map-svg");
  svg.setAttribute("viewBox",`0 0 ${map.clientWidth} ${map.clientHeight}`);
  const positions = new Map([...map.querySelectorAll("[data-node]")].map(element => {
    const box = element.getBoundingClientRect();
    return [element.dataset.node, {left:box.left-bounds.left, right:box.right-bounds.left,
      centerY:box.top-bounds.top+box.height/2}];
  }));
  svg.querySelector(".edge-paths").innerHTML = edges.map(({from,to},index) => {
    const a = positions.get(from), b = positions.get(to);
    if (!a || !b) return "";
    let path;
    if (Math.abs(a.left-b.left) < 2) {
      // Route same-column edges beside the cards, including the stacked mobile layout.
      const rail = Math.max(3,a.left-12-(index%3)*3);
      const route = Math.sign(b.centerY-a.centerY)*Math.min(22,Math.abs(b.centerY-a.centerY)/3);
      path = `M${a.left},${a.centerY} Q${rail},${a.centerY} ${rail},${a.centerY+route} L${rail},${b.centerY-route} Q${rail},${b.centerY} ${b.left-3},${b.centerY}`;
    } else {
      const direction = Math.sign(b.left-a.left);
      const start = direction > 0 ? a.right : a.left;
      const end = direction > 0 ? b.left-3 : b.right+3;
      const bend = (end-start)*.5;
      path = `M${start},${a.centerY} C${start+bend},${a.centerY} ${end-bend},${b.centerY} ${end},${b.centerY}`;
    }
    const hot = from === selected || to === selected ? ' class="hot"' : "";
    return '<path' + hot + ' data-edge-from="' + esc(from) + '" data-edge-to="' + esc(to) + '" d="' + path +
      '" marker-end="url(#arrow)"/>';
  }).join("");
}

function inspect(graph = data.graphs[account][mode]) {
  for (const element of document.querySelectorAll("[data-node]")) {
    element.setAttribute("aria-pressed",String(element.dataset.node === selected));
  }
  for (const element of document.querySelectorAll("[data-edge-from]")) {
    element.classList.toggle("hot",element.dataset.edgeFrom === selected || element.dataset.edgeTo === selected);
  }
  const node = graph.nodes.find(item => item.id === selected);
  if (!node) return;
  const relatedDataset = node.type === "account" ? "v_account_portfolio" : node.type;
  const connections = graph.edges.filter(edge => edge.from === selected || edge.to === selected);
  const eventId = node.type === "engagement_event" ? node.id : node.fields["Evidence event"] ?? node.fields["Event ID"];
  const observationsLink = eventId ? '<button class="ref" type="button" data-dataset="v_event_observations" data-event="' +
    esc(eventId) + '">Open event observations</button>' : '';
  const inspector = view.querySelector("#inspector");
  const outreach = node.outreach_scope ?
    '<button class="action review-outreach" type="button" data-review-outreach="' + esc(node.id) + '">Review outreach</button>' : "";
  inspector.innerHTML =
    '<p class="kind type-' + esc(node.type) + '">' + esc(typeLabels[node.type] ?? node.type) + '</p><h2>' + esc(node.label) + '</h2>' + outreach + '<dl>' +
    Object.entries(node.fields).map(([key,value]) => '<dt>' + esc(key) + '</dt><dd>' + esc(value ?? "Unknown") + '</dd>').join("") + '</dl>' +
    '<div class="related"><button class="ref" type="button" data-dataset="' + esc(relatedDataset) +
    '">Open ' + esc(relatedDataset) + '</button>' + observationsLink + '</div>' +
    (connections.length ? '<div class="related"><h3>Connections</h3>' + connections.map(edge => {
      const fromHere = edge.from === selected;
      const linked = graph.nodes.find(item => item.id === (fromHere ? edge.to : edge.from));
      return '<button class="edge-link" type="button" data-related="' + esc(linked.id) + '"><span>' +
        (fromHere ? "Outgoing · " : "Incoming · ") + esc(edge.label) + '</span><strong>' + esc(linked.label) + '</strong></button>';
    }).join("") + '</div>' : '');
  inspector.scrollTop = 0;
}

function buildFlow() {
  const labels = {
    version:"Rule version",snapshot_time:"As-of time",adoption:"Adoption eligibility",adoption_quality:"Telemetry quality",
    expansion:"Expansion eligibility",context:"Context signals",health:"Health and value",action_boundary:"Actions",
    account_identifiers:"Account identifiers", licensing:"Seat utilization", portfolio_adoption:"Portfolio adoption",
    action_revision:"Action revisions", lifecycle_results:"Lifecycle outcomes",
    evidence_event:"Evidence events", observation:"Observations", workstream:"Workstreams",
    expansion_research:"Expansion research", identity_match:"Identity matching", stakeholder_intent:"Stakeholder intent", outreach_drafts:"Outreach drafts",
    outreach_approval:"Outreach approval", outreach_activity:"Outreach activity",
  };
  view.innerHTML = '<div class="flow-grid">' + data.ontology.data_flow.map(stage =>
    '<article class="panel flow-card"><h2>' + esc(stage.title) + '</h2><p>' + esc(stage.description) + '</p><div class="ref-list">' +
    stage.datasets.map(name => '<button class="ref" type="button" data-dataset="' + esc(name) + '">' + esc(name) + '</button>').join("") +
    '</div></article>').join("") + '</div><div class="panel warehouse-loop"><div><strong>Warehouse writeback</strong>' +
    '<p>CSM actions and outreach revisions write back to the warehouse. Simulated delivery events appear on the account timeline.</p></div>' +
    '<div class="ref-list"><button class="ref" type="button" data-dataset="v_customer_action_history">v_customer_action_history</button>' +
    '<button class="ref" type="button" data-dataset="cs_outreach_revision">cs_outreach_revision</button></div></div>' +
    '<section class="panel rules"><h2>Decision rules</h2><dl>' +
    Object.entries(data.ontology.rules).map(([key,value]) => '<dt>' + esc(labels[key] ?? key) + '</dt><dd>' + esc(value) + '</dd>').join("") +
    '</dl></section>';
}

function buildDataset(loadLive = true) {
  const definition = data.ontology.datasets[dataset];
  const {columns,rows:allRows} = data.datasets[dataset];
  const rows = evidenceEvent ? allRows.filter(row => row.event_id === evidenceEvent) : allRows;
  const scope = evidenceEvent ? '<span><strong>Event </strong><code>' + esc(evidenceEvent) +
    '</code></span><button type="button" class="ref" id="clear-event">Show all events</button>' : '';
  view.innerHTML = '<div class="data-head"><div><label class="field">Dataset <select id="dataset-select">' +
    Object.entries(data.ontology.datasets).map(([key,item]) => option(key,item.label,dataset)).join("") +
    '</select></label><h2>' + esc(definition.label) + '</h2><p>' + esc(definition.grain) +
    '</p></div><button type="button" class="action" id="download-csv">Download CSV</button></div><div class="data-summary"><span><strong>Key </strong>' +
    esc(definition.key) + '</span><span><strong>Dataset </strong><code>' + esc(dataset) + '</code></span><span><strong>Authority </strong>' + esc(definition.authority) + '</span><span>' + rows.length +
    ' rows</span>' + scope + '</div><div class="panel table-scroll" tabindex="0" role="region" aria-label="Dataset rows"><table><thead><tr>' +
    columns.map(name => '<th scope="col">' + esc(name) + '</th>').join("") + '</tr></thead><tbody>' +
    rows.map(row => '<tr>' + columns.map(field => '<td>' + esc(row[field] ?? "—") + '</td>').join("") + '</tr>').join("") +
    '</tbody></table></div>';
  if (loadLive && liveConsole && definition.live_outreach) {
    const key = dataset;
    const table = view.querySelector(".table-scroll");
    consoleCall("describe_dataset",{dataset:key,limit:25}).then(result => {
      if (!table.isConnected || dataset !== key) return;
      data.datasets[key] = {columns:result.columns,rows:result.rows};
      buildDataset(false);
    }).catch(error => {
      if (table.isConnected) table.insertAdjacentHTML("beforebegin",'<p class="workflow-error" role="alert">' + esc(error.message) + '</p>');
    });
  }
}

function render() {
  for (const button of document.querySelectorAll("[data-view]")) button.setAttribute("aria-pressed",String(button.dataset.view === active));
  if (active === "graph") buildGraph();
  else {
    graphObserver?.disconnect();
    if (active === "flow") buildFlow();
    else if (active === "datasets") buildDataset();
    else if (active === "outreach") buildOutreach();
    else if (active === "timeline") buildTimeline();
  }
}

document.addEventListener("click",event => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.view) {
    active = button.dataset.view;
    render();
  } else if (button.dataset.mode) {
    mode = button.dataset.mode; selected = undefined; buildGraph();
    document.querySelector('[data-mode="' + mode + '"]').focus();
  } else if (button.dataset.node || button.dataset.related) {
    selected = button.dataset.node ?? button.dataset.related;
    inspect();
    if (button.dataset.related) [...document.querySelectorAll("[data-node]")].find(item => item.dataset.node === selected)?.focus();
  } else if (button.dataset.reviewOutreach || button.dataset.openDraft) {
    outreachPersonId = button.dataset.reviewOutreach ?? button.dataset.prospect;
    outreachDraftId = button.dataset.openDraft;
    active = "outreach";
    render();
    document.querySelector("#outreach-person")?.focus();
  } else if (button.dataset.openEvent) {
    timelineEventId = button.dataset.openEvent;
    active = "timeline";
    render();
  } else if (button.dataset.timelineEvent) {
    showTimelineEvent(button.dataset.timelineEvent);
  } else if (button.dataset.dataset) {
    dataset = button.dataset.dataset; evidenceEvent = button.dataset.event; active = "datasets"; render();
    document.querySelector("#dataset-select").focus();
  } else if (button.id === "clear-event") {
    evidenceEvent = undefined; buildDataset(); document.querySelector("#dataset-select").focus();
  } else if (button.id === "download-csv") {
    const {columns,rows:allRows} = data.datasets[dataset];
    const rows = evidenceEvent ? allRows.filter(row => row.event_id === evidenceEvent) : allRows;
    const cell = value => '"' + String(value ?? "").replaceAll('"','""') + '"';
    const csv = [columns.map(cell).join(","), ...rows.map(row => columns.map(field => cell(row[field])).join(","))].join("\r\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));
    link.download = dataset + (evidenceEvent ? "_" + evidenceEvent : "") + ".csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href),2000);
  }
});
document.addEventListener("change",event => {
  if (event.target.id === "account-select") {
    account = event.target.value;
    selected = outreachPersonId = outreachDraftId = timelineEventId = undefined;
    render(); document.querySelector("#account-select").focus();
  } else if (event.target.id === "outreach-person") {
    outreachPersonId = event.target.value;
    outreachDraftId = undefined;
    buildOutreach(); document.querySelector("#outreach-person").focus();
  } else if (event.target.id === "dataset-select") {
    dataset = event.target.value; evidenceEvent = undefined; buildDataset(); document.querySelector("#dataset-select").focus();
  }
});
