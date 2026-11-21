const select = document.querySelector("#account-select");
const refreshButton = document.querySelector("#refresh");
const freshness = document.querySelector("#freshness");
const notice = document.querySelector("#notice");
const roleIndicator = document.querySelector("#account-role");
const accountView = document.querySelector("#account-view");
const contacts = document.querySelector("#contact-nodes");
const timeline = document.querySelector("#events");
const date = new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"short"});
const display = value => date.format(new Date(value));
const esc = value => String(value ?? "").replace(/[&<>"']/g,character =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[character]);

let selectedAccount;
let accounts = [];
let selectedNode;
let selectedEvent;
let graph;
let revision = 0;
let pending = false;
let accountOptionsKey;
let graphKey;
let eventsKey;
document.querySelector("#mcp-url").textContent = location.origin + "/mcp";

async function call(name,args = {}) {
  const response = await fetch("/api/console",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})});
  if (response.status === 401) throw new Error("Your session expired. Reload and sign in.");
  if (!response.ok) throw new Error("Could not load current data. Try refreshing.");
  const {result,error} = await response.json();
  if (error || result?.isError) throw new Error(error?.message || result.content[0].text);
  return result.structuredContent;
}

function hideAccount() {
  accountView.hidden = true;
  roleIndicator.hidden = true;
  document.dispatchEvent(new CustomEvent("pilot-account",{detail:null}));
}

function connectNode() {
  const path = document.querySelector("#contact-path");
  const map = path.closest(".map");
  const root = document.querySelector("#account-node button");
  const person = [...contacts.querySelectorAll("button")].find(button => button.getAttribute("aria-pressed") === "true");
  if (!root || !person) { path.removeAttribute("d"); return; }
  const bounds = map.getBoundingClientRect();
  const a = root.getBoundingClientRect();
  const b = person.getBoundingClientRect();
  const list = contacts.getBoundingClientRect();
  const y = (b.top + b.bottom)/2;
  if (y < list.top || y > list.bottom) { path.removeAttribute("d"); return; }
  const x1 = a.right - bounds.left;
  const x2 = b.left - bounds.left;
  const midpoint = (x1+x2)/2;
  const y1 = (a.top+a.bottom)/2 - bounds.top;
  const y2 = y - bounds.top;
  const route = Math.abs(x1-x2) > 15 && x1 < x2 ?
    `M ${x1} ${y1} C ${midpoint} ${y1} ${midpoint} ${y2} ${x2} ${y2}` :
    `M ${a.left-bounds.left} ${y1} H 10 V ${y2} H ${x2}`;
  path.setAttribute("d",route);
}

function inspectNode(id) {
  const node = graph.nodes.find(item => item.id === id) ?? graph.nodes[0];
  selectedNode = node.id;
  for (const card of document.querySelectorAll("[data-node]")) {
    card.setAttribute("aria-pressed",String(card.dataset.node === selectedNode));
  }
  document.querySelector("#graph-detail").innerHTML = '<p class="kind">' + esc(node.type === "person" ? "Contact" : "Account") +
    '</p><h2>' + esc(node.label) + '</h2><dl>' + Object.entries(node.fields).map(([key,value]) =>
    '<dt>' + esc(key) + '</dt><dd>' + esc(key === "Source modified" || key === "Last synced" ? display(value) : value) + '</dd>').join("") + '</dl>';
  connectNode();
}

function renderGraph(next) {
  const key = JSON.stringify(next.nodes);
  graph = next;
  if (key === graphKey) return;
  graphKey = key;
  const scrollTop = contacts.scrollTop;
  const card = node => '<button class="node type-' + node.type + '" data-node="' + esc(node.id) +
    '" type="button" aria-pressed="false"><strong>' + esc(node.label) + '</strong><span>' + esc(node.subtitle) + '</span></button>';
  document.querySelector("#account-node").innerHTML = card(next.nodes[0]);
  contacts.innerHTML = next.nodes.length > 1 ? next.nodes.slice(1).map(card).join("") : '<p class="empty">No visible contacts</p>';
  contacts.scrollTop = scrollTop;
  inspectNode(selectedNode);
}

function showEvent(id,events) {
  const event = events.find(row => row.event_id === id);
  selectedEvent = event?.event_id;
  for (const button of timeline.querySelectorAll("[data-event]")) {
    button.setAttribute("aria-pressed",String(button.dataset.event === selectedEvent));
  }
  document.querySelector("#event-detail").innerHTML = event ?
    '<h2>' + esc(event.title) + '</h2><p class="workflow-muted">Salesforce · ' + esc(display(event.occurred_at)) +
    '</p><p class="pilot-summary">' + esc(event.summary) + '</p><dl class="message-address"><dt>Recorded</dt><dd>' +
    esc(display(event.recorded_at)) + '</dd><dt>Event ID</dt><dd><code>' + esc(event.event_id) + '</code></dd></dl>' : "";
}

let currentEvents = [];
function renderTimeline(events) {
  const key = JSON.stringify(events);
  if (eventsKey === key) return;
  eventsKey = key;
  currentEvents = events;
  timeline.innerHTML = events.length ? events.map(event =>
    '<button class="timeline-row" type="button" data-event="' + esc(event.event_id) + '" aria-pressed="false"><span>' +
    esc(display(event.occurred_at)) + ' · Salesforce</span><strong>' + esc(event.title) + '</strong></button>').join("") :
    '<p class="empty">No synced changes</p>';
  showEvent(events.some(row => row.event_id === selectedEvent) ? selectedEvent : events[0]?.event_id,events);
}

async function refresh(refreshAccounts = true) {
  const current = ++revision;
  pending = true;
  refreshButton.disabled = true;
  notice.hidden = true;
  try {
    if (refreshAccounts) {
      const {accounts:visible} = await call("list_accounts");
      if (current !== revision) return;
      accounts = visible;
      const optionsKey = JSON.stringify(accounts.map(row => [row.account_id,row.account_name]));
      if (optionsKey !== accountOptionsKey) {
        accountOptionsKey = optionsKey;
        select.innerHTML = accounts.map(row => '<option value="' + esc(row.account_id) + '">' + esc(row.account_name) + '</option>').join("");
      }
      selectedAccount = accounts.find(row => row.account_id === selectedAccount)?.account_id ?? accounts[0]?.account_id;
      select.disabled = !selectedAccount;
      select.value = selectedAccount ?? "";
    }
    if (!selectedAccount) {
      hideAccount();
      freshness.textContent = "No assigned Salesforce accounts";
      return;
    }
    const args = {account:selectedAccount};
    const [next,timelineResult] = await Promise.all([call("get_knowledge_graph",args),call("list_timeline",{...args,limit:50})]);
    if (current !== revision) return;
    accountView.hidden = false;
    const {roles,permissions} = accounts.find(row => row.account_id === args.account);
    roleIndicator.textContent = roles.map(role => ({viewer:"Viewer",csm:"CSM",approver:"Approver",
      gong_operator:"Gong operator",access_admin:"Access admin"})[role]).join(" · ");
    roleIndicator.hidden = false;
    const synced = Math.min(Date.parse(next.freshness.synced_at),Date.parse(timelineResult.freshness.synced_at));
    freshness.textContent = "Salesforce synced " + display(synced) + (Date.now()-synced > 900000 ? " · Check sync" : "");
    renderGraph(next);
    renderTimeline(timelineResult.events);
    connectNode();
    document.dispatchEvent(new CustomEvent("pilot-account",{detail:{accountId:args.account,permissions,
      contacts:next.nodes.filter(node=>node.type==="person")}}));
  } catch (error) {
    if (current !== revision) return;
    hideAccount();
    notice.textContent = error.message;
    notice.hidden = false;
    freshness.textContent = "Refresh unavailable";
  } finally {
    if (current === revision) {
      pending = false;
      refreshButton.disabled = false;
    }
  }
}

select.addEventListener("change",() => {
  selectedAccount = select.value;
  selectedNode = selectedEvent = undefined;
  accountView.hidden = true;
  refresh(false);
});
refreshButton.addEventListener("click",() => refresh());
document.querySelector("#sign-out").addEventListener("click",async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await fetch("/logout",{method:"POST"});
    if (!response.ok) throw new Error("Sign-out failed. Try again.");
    location.assign("/");
  } catch {
    notice.textContent = "Sign-out failed. Try again.";
    notice.hidden = false;
    button.disabled = false;
  }
});
document.querySelector(".pilot-map").addEventListener("click",event => {
  const node = event.target.closest("[data-node]")?.dataset.node;
  if (node && graph) inspectNode(node);
});
timeline.addEventListener("click",event => {
  const id = event.target.closest("[data-event]")?.dataset.event;
  if (id) showEvent(id,currentEvents);
});
contacts.addEventListener("scroll",connectNode);
new ResizeObserver(connectNode).observe(document.querySelector(".pilot-map"));
setInterval(() => { if (!pending && !document.hidden) refresh(); },30000);
refresh();
