import { RequestError } from "./service.mjs";

const VERSION = "2026-07-28";
const LEGACY = "2025-11-25";
const SUPPORTED = [VERSION, LEGACY, "2025-06-18", "2025-03-26"];
const PROTOCOL_META = "io.modelcontextprotocol/protocolVersion";
const SERVER_META = "io.modelcontextprotocol/serverInfo";
const SERVER = {name: "endor-digital-cs", title: "Digital Customer Success", version: "1.6.0"};
const INSTRUCTIONS = "Fictional Endor Labs customer-success snapshot and action register. Cite source event, observation or telemetry IDs. Use research_expansion_buying_group for simulated Sumble and Clay research, and get_expansion_engagement_history for each stakeholder’s sourced hypotheses, why the content matters, why now, Endor product fit and proposed 1:1. Use draft_expansion_outreach to preview copy. On explicit user instruction, save_outreach_draft stores a draft and update_outreach_draft records an edit, approval, simulated Gong handoff, simulated send or simulated reply. Obtain the current revision with get_outreach_draft before making changes. Gong and email delivery are simulated. Attribute customer statements to their actual source and keep hypotheses conditional.";
const ANNOTATIONS = {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false};
const string = (description, maxLength = 160) => ({type:"string", description, minLength:1, maxLength});
const oneOf = (description, values) => ({type:"string", description, enum:values});
const count = (description, maximum) => ({type:"integer", description, minimum:1, maximum});
const account = string("Canonical account ID or exact account name.");
const buying_group = string("Target buying-group ID or exact name. Use research_expansion_buying_group to discover available targets.");
const person = string("Candidate ID or exact name from the selected expansion buying group.");
const actionId = string("Action ID returned by list_customer_actions.");
const actionStatuses = ["open","in_progress","blocked","completed"];
const outreachRoute = oneOf("Omit for the evidence-backed recommendation between a warm introduction and direct follow-up.",["warm_intro","direct_follow_up"]);
const outreachDraftId = string("Draft ID returned by list_outreach_drafts or save_outreach_draft.");
const definitions = [
  ["list_accounts", "List accounts", "List canonical account IDs and names, dated health and churn risk, licensed seats, contributor utilization, and repository adoption.", "listAccounts", {}, []],
  ["get_account", "Get account brief", "Get health, churn risk, buying groups, contract seats, current and proposed Endor product use cases, adoption, scoped outcomes and owned actions.", "getAccount", {account}, ["account"]],
  ["list_work_queue", "List work queue", "List evidence-backed stalled-adoption interventions and first-party expansion discovery cases. Check snapshot freshness and next checkpoint.", "listWorkQueue",
    {playbook:oneOf("Which playbook to list.", ["all","stalled_adoption","expansion"]), account}, []],
  ["list_customer_actions", "List owned customer-success actions", "List actions in due-date order with the accountable owner, buying group, source evidence and status. Active actions are shown by default.", "listCustomerActions",
    {account, job_kind:oneOf("Customer-success job to filter.", ["first_value","rollout","renewal","risk","expansion"]),
     status:oneOf("Action status to filter.", ["active","all",...actionStatuses]), limit:count("Maximum number of actions.", 50)}, []],
  ["get_customer_action", "Open a customer-success action", "Get the current action revision, product and buying-group scope, source observations, workstream context and revision history.", "getCustomerAction",
    {action_id:actionId}, ["action_id"]],
  ["record_customer_action", "Record a customer-success action update", "On the user's instruction, append a status update or completion outcome to the action register. A completed action can create one owned follow-up. Use the current revision from get_customer_action.", "recordCustomerAction",
    {action_id:actionId, expected_revision:{type:"integer", minimum:0, maximum:2147483646, description:"Current action revision. A new action starts at 0."},
     status:oneOf("Status after the update.", actionStatuses), note:string("Observed outcome or progress note.", 2000),
     due_on:string("Optional revised due date in YYYY-MM-DD."), evidence_event_id:string("Optional source event mapped to the workstream's product use case and buying group."),
     follow_up_title:string("Optional next action to create on completion. Supply its due date too."),
     follow_up_on:string("Optional next action due date in YYYY-MM-DD.")}, ["action_id","expected_revision","status","note"], false],
  ["list_timeline", "List activity timeline", "List an account's email, meeting, webinar, download, product, support and market events newest first, optionally filtered by buying group and contact.", "listTimeline",
    {account, buying_group_id:string("Optional canonical buying-group ID from get_account."), person_id:string("Optional contact ID from get_account."),
     limit:count("Maximum number of events.", 50), before_utc:string("Optional exclusive ISO date or timestamp cutoff.")}, ["account"]],
  ["get_event", "Open source evidence", "Open an event and its typed observations. Returns source text, message IDs and sender for email, and the product, use case and buying group behind each scoped observation.", "getEvent",
    {event_id:string("Event ID from the timeline or the work queue.")}, ["event_id"]],
  ["get_adoption_history", "Get deployment adoption history", "Return dated adoption coverage, numerator, denominator, scope version and target for the account's deployments.", "getAdoptionHistory", {account}, ["account"]],
  ["research_expansion_buying_group", "Research an expansion buying group", "Find simulated Sumble team, project, stack and hiring signals and Clay prospects who are missing from the demo CRM. Scope by business unit or subsidiary and show role hypotheses, evidence, CRM matches and identity checks. Omit scope to list available targets.", "researchExpansionBuyingGroup", {account,buying_group}, []],
  ["get_expansion_engagement_history", "Open first-party expansion engagement", "Develop a stakeholder point of view from attributed history, exact asset agenda and question, colleague conversations, and simulated company signals. Explain competing intent hypotheses, why these resources, why now, relevant Endor value and the proposed CSM 1:1.", "getExpansionEngagementHistory", {account,buying_group,person}, []],
  ["draft_expansion_outreach", "Draft expansion outreach", "Draft a 1:1 invitation or warm introduction using the stakeholder’s evidence-backed point of view. Returns the draft, why now, success checks and source IDs for review.", "draftExpansionOutreach",
    {account,buying_group,person,route:outreachRoute}, []],
  ["list_outreach_drafts", "Find saved outreach drafts", "List draft status, recipient, buying group, and linked expansion case within an account.", "listOutreachDrafts",
    {account,buying_group,person,limit:count("Maximum number of drafts.",50)}, ["account"]],
  ["get_outreach_draft", "Open saved outreach draft", "Read the exact saved copy, cited evidence, revision history, simulated Gong handoff, and simulated email events.", "getOutreachDraft",
    {draft_id:outreachDraftId}, ["draft_id"]],
  ["save_outreach_draft", "Generate and save an outreach draft", "On explicit instruction, generate evidence-based copy and save it in the warehouse for review.", "saveOutreachDraft",
    {account,buying_group,person,route:outreachRoute,request_id:string("Optional unique request ID. Reuse it when retrying this save.",100)},
    ["account","buying_group","person"], false],
  ["update_outreach_draft", "Update an outreach workflow", "On explicit instruction, edit or approve copy, queue the approved draft in simulated Gong, record a simulated send, or log a simulated reply. Only simulated send and reply are timeline events.", "updateOutreachDraft",
    {draft_id:outreachDraftId,expected_revision:{type:"integer",minimum:0,maximum:2147483646,description:"Current revision from get_outreach_draft."},
     operation:oneOf("Edit, approve, queue in simulated Gong, simulate a send, or log a simulated reply.",["edit","approve","queue","send","reply"]),
     subject:string("Single-line subject when editing, approving modified copy, or simulating a send with a final edit.",240),
     body:string("Email body. For a simulated reply, supply only the reply body.",8000)},
    ["draft_id","expected_revision","operation"], false],
  ["get_knowledge_graph", "Get the knowledge graph", "Return typed nodes and links for buying relationships, decision evidence, owned actions or expansion research.", "getKnowledgeGraph",
    {account, mode:oneOf("Select a graph view.", ["relationships","evidence","actions","expansion_research"])}, ["account"]],
  ["describe_dataset", "Browse canonical datasets", "List canonical tables and decision views or return a dataset's key, grain, source, and preview rows.", "describeDataset",
    {dataset:string("SQL table or view name from the dataset catalog."), limit:count("Maximum number of preview rows.", 25)}, []],
  ["get_business_ontology", "Read the business ontology", "Get business definitions, relationship cardinality, data flow and decision rules. Optionally narrow to one canonical dataset.", "getOntology",
    {dataset:string("Optional canonical table or view name.")}, []],
];
const tools = new Map(definitions.map(([name, title, description, handler, properties, required, readOnlyHint = true]) => [
  name, {handler, descriptor: {name, title, description,
    inputSchema:{type:"object", properties, required, additionalProperties:false}, annotations:{...ANNOTATIONS, readOnlyHint}}},
]));

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

function validate(input, schema) {
  if (!object(input)) throw new RequestError("Tool arguments must be an object.");
  for (const key of schema.required) {
    if (!Object.hasOwn(input, key)) throw new RequestError("Missing required argument: " + key);
  }
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(schema.properties, key)) throw new RequestError("Unexpected argument: " + key);
    const spec = schema.properties[key];
    if (spec.type === "integer") {
      if (!Number.isInteger(value) || value < spec.minimum || value > spec.maximum) {
        throw new RequestError(key + " must be an integer between " + spec.minimum + " and " + spec.maximum + ".");
      }
    } else if (typeof value !== "string" || !value.trim() || value.length > (spec.maxLength ?? 160) ||
               (spec.enum && !spec.enum.includes(value))) {
      throw new RequestError("Invalid value for " + key + ".");
    }
  }
  return input;
}

export const rpcError = (id, code, message, data) => ({
  jsonrpc:"2.0", id:id ?? null, error:{code, message, ...(data === undefined ? {} : {data})},
});
const rpcReply = (id, result) => ({jsonrpc:"2.0", id, result});
const content = (text, isError=false) => ({content:[{type:"text",text}], ...(isError ? {isError:true} : {})});
const serverMetadata = {[SERVER_META]:SERVER, [PROTOCOL_META]:VERSION};

export function createDispatcher(service, context = {}, {instructions = INSTRUCTIONS, descriptors = {}} = {}) {
  const descriptorFor = (name, tool) => ({...tool.descriptor,...descriptors[name]});
  return async function dispatch(message, declaredVersion) {
    if (!object(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return rpcError(null, -32600, "Invalid JSON-RPC request.");
    }
    const {method, id} = message;
    if (id === undefined) return null;
    if (typeof id !== "string" && !Number.isInteger(id)) {
      return rpcError(null, -32600, "Request ID must be a string or integer.");
    }
    const params = message.params ?? {};
    if (!object(params)) return rpcError(id,-32602,"Parameters must be an object.");
    const revision = params._meta?.[PROTOCOL_META] ?? declaredVersion;
    const attachMeta = result => revision === VERSION ? {...result,_meta:serverMetadata} : result;
    if (method === "server/discover") {
      return rpcReply(id,{supportedVersions:SUPPORTED, capabilities:{tools:{}}, instructions,_meta:serverMetadata});
    }
    if (method === "initialize") {
      const requested = params.protocolVersion;
      const protocolVersion = requested !== VERSION && SUPPORTED.includes(requested) ? requested : LEGACY;
      return rpcReply(id,{protocolVersion, capabilities:{tools:{}}, serverInfo:SERVER, instructions});
    }
    if (revision && !SUPPORTED.includes(revision)) {
      return rpcError(id,-32022,"Unsupported protocol version",{supported:SUPPORTED,requested:revision});
    }
    if (method === "ping") return rpcReply(id,attachMeta({}));
    if (method === "tools/list") {
      return rpcReply(id,attachMeta({tools:[...tools].filter(([,tool]) => service[tool.handler]).map(([name,tool]) => descriptorFor(name,tool))}));
    }
    if (method !== "tools/call") return rpcError(id, -32601, "Method not found.");
    const tool = tools.get(params.name);
    if (!tool || !service[tool.handler]) return rpcError(id, -32602, "Unknown tool name.");
    try {
      const args = validate(params.arguments ?? {}, descriptorFor(params.name,tool).inputSchema);
      const data = await service[tool.handler](args,context);
      return rpcReply(id,attachMeta({...content(JSON.stringify(data)), structuredContent:data}));
    } catch (error) {
      const message = error instanceof RequestError ? error.message : "The canonical snapshot could not be queried.";
      if (!(error instanceof RequestError)) console.error("Customer success query failed:", error.message);
      return rpcReply(id,attachMeta(content(message,true)));
    }
  };
}

const MAX_BODY = 65536;

export async function readJSON(request) {
  if (!request.body) return null;
  if (Number(request.headers.get("content-length")) > MAX_BODY) throw new RangeError("Request exceeds 64 KB.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", {fatal:true});
  let size = 0;
  let text = "";
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      throw new RangeError("Request exceeds 64 KB.");
    }
    text += decoder.decode(value,{stream:true});
  }
  return JSON.parse(text + decoder.decode());
}

const json = (payload,status=200) => new Response(JSON.stringify(payload), {
  status, headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"},
});

export async function handleMcp(request, dispatch, allowedOrigins = []) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin && !allowedOrigins.includes(origin)) {
    return json(rpcError(null,-32600,"Origin is not allowed."),403);
  }
  if (request.method !== "POST") {
    return new Response(null,{status:405,headers:{Allow:"POST"}});
  }
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return json(rpcError(null,-32600,"Content-Type must be application/json."),415);
  }
  let message;
  try {
    message = await readJSON(request);
  } catch (error) {
    const large = error instanceof RangeError;
    return json(rpcError(null,large ? -32600 : -32700,large ? error.message : "Invalid JSON."), large ? 413 : 400);
  }
  const headerVersion = request.headers.get("MCP-Protocol-Version");
  const bodyVersion = message?.params?._meta?.[PROTOCOL_META];
  const headerMethod = request.headers.get("Mcp-Method");
  const headerName = request.headers.get("Mcp-Name");
  if ((headerVersion && bodyVersion && headerVersion !== bodyVersion) ||
      (headerMethod && headerMethod !== message?.method) ||
      (headerName && headerName !== message?.params?.name)) {
    return json(rpcError(message?.id,-32001,"Request metadata does not match its headers."),400);
  }
  const response = await dispatch(message,headerVersion);
  if (response === null) return new Response(null,{status:202});
  if (response.error?.code === -32600 || response.error?.code === -32022) return json(response,400);
  if (response.error?.code === -32601 && (headerVersion ?? bodyVersion) === VERSION) return json(response,404);
  return json(response);
}
