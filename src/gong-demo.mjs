import {createHash, randomUUID} from "node:crypto";
import {once} from "node:events";
import {copyFile, link, rm} from "node:fs/promises";
import {createServer} from "node:http";
import {Readable} from "node:stream";
import {fileURLToPath} from "node:url";
import {emailBodyHtml} from "./email-copy.mjs";
import {readJSON} from "./mcp.mjs";
import {RequestError} from "./service.mjs";

const webhookPath = "/webhooks/gong-engage";
const assignmentPath = "/v2/flows/prospects/assign";
const flowName = "Copperline Platform Engineering | Manual follow-up";
const flowId = "7100320000000000101";
const crmProspectId = "00Q000000000101EAA";
const flowInstanceOwnerEmail = "morgan@endor-demo.example";

export async function gongDemoDatabasePath() {
  const seed = new URL("../data/canonical.sqlite3", import.meta.url);
  const database = new URL("gong-demo.sqlite3", seed);
  const incoming = new URL(`gong-demo.sqlite3.${randomUUID()}.tmp`, seed);
  // Publish a complete copy before a second Claude process can open it.
  try {
    await copyFile(seed, incoming);
    await link(incoming, database);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  } finally {
    await rm(incoming, {force:true});
  }
  return fileURLToPath(database);
}

function validWebhook({draftId, approvedRevision, assignment, manualEmail} = {}) {
  return typeof draftId === "string" && /^outreach:[a-zA-Z0-9_-]{8,100}$/.test(draftId) &&
    Number.isInteger(approvedRevision) && approvedRevision > 0 && assignment?.flowId === flowId &&
    assignment.flowInstanceOwnerEmail === flowInstanceOwnerEmail && Array.isArray(assignment.crmProspectsIds) &&
    assignment.crmProspectsIds.length === 1 && assignment.crmProspectsIds[0] === crmProspectId &&
    manualEmail?.stepNumber === 1 && typeof manualEmail.subject === "string" && manualEmail.subject.trim() &&
    typeof manualEmail.bodyHtml === "string" && manualEmail.bodyHtml.trim();
}

export async function startGongDemoWebhook() {
  const authorization = "Bearer " + randomUUID();
  const server = createServer(async (incoming, outgoing) => {
    if (incoming.method !== "POST" || incoming.url !== webhookPath) return outgoing.writeHead(404).end();
    if (incoming.headers.authorization !== authorization) return outgoing.writeHead(401).end();
    let event;
    try {
      event = await readJSON(new Request(url, {
        method:"POST", headers:incoming.headers, body:Readable.toWeb(incoming), duplex:"half",
      }));
    } catch {
      return outgoing.writeHead(400).end();
    }
    if (!event || !validWebhook(event)) return outgoing.writeHead(400).end();
    const key = createHash("sha256").update(`${event.draftId}:${event.approvedRevision}`).digest("hex").slice(0,24);
    // The SQLite revision is the durable queue record. A retry returns the same receipt.
    const result = {
      requestId:`demo-request-${key}`,
      prospectsAssigned:[{
        flowId, flowName, crmProspectId, flowInstanceOwnerEmail,
        flowInstanceId:`demo-instance-${key}`, flowInstanceStatus:"Running",
      }],
      prospectsNotAssigned:[],
    };
    outgoing.writeHead(200, {"Content-Type":"application/json", "Cache-Control":"no-store"}).end(JSON.stringify(result));
  });
  await once(server.listen(0,"127.0.0.1"),"listening");
  const url = new URL(webhookPath, `http://127.0.0.1:${server.address().port}`);

  return {
    flowId,
    close:() => server[Symbol.asyncDispose](),
    async assign(draft) {
      if (draft.account_id !== "AC0003" || draft.buying_group_id !== "copperline:platform-engineering" ||
          draft.recipient_id !== "clay-cc-jo" || draft.recipient_email !== "jo.mercer@copperline.example" ||
          draft.sender_email !== flowInstanceOwnerEmail || draft.route !== "direct_follow_up") {
        throw new RequestError("This demo flow accepts Jo Mercer's Copperline Platform Engineering direct follow-up. Save a direct follow-up draft for Jo to continue.");
      }
      const assignment = {crmProspectsIds:[crmProspectId], flowId, flowInstanceOwnerEmail};
      const manualEmail = {stepNumber:1, subject:draft.subject, bodyHtml:emailBodyHtml(draft.body)};
      let response, result;
      try {
        response = await fetch(url, {
          method:"POST", headers:{"Content-Type":"application/json", Authorization:authorization},
          body:JSON.stringify({draftId:draft.draft_id, approvedRevision:draft.revision, assignment, manualEmail}),
          redirect:"error", signal:AbortSignal.timeout(5000),
        });
        result = await response.json();
      } catch {
        throw new RequestError("The local Gong webhook did not return a receipt. The draft is still approved. Retry the handoff.");
      }
      const assigned = result?.prospectsAssigned;
      const item = assigned?.[0];
      if (!response.ok || !Array.isArray(assigned) || assigned.length !== 1 || result.prospectsNotAssigned?.length !== 0 ||
          item?.flowId !== flowId || item.crmProspectId !== crmProspectId ||
          item.flowInstanceOwnerEmail !== flowInstanceOwnerEmail || typeof item.flowInstanceId !== "string" || !item.flowInstanceId) {
        throw new RequestError("The local Gong webhook did not confirm the expected flow and recipient. The draft is still approved.");
      }
      return {
        provider:"Gong Engage", mode:"simulated", method:"POST", path:assignmentPath,
        crm_prospect_id:crmProspectId, identity_resolution:"Jo Mercer · fictional CRM lead",
        flow_id:flowId, owner_email:flowInstanceOwnerEmail, step_type:"manual_email",
        step_override:{step:manualEmail.stepNumber, subject:manualEmail.subject, body_html:manualEmail.bodyHtml},
        flow_instance_id:item.flowInstanceId, approved_revision:draft.revision,
        webhook:{method:"POST", path:webhookPath, http_status:response.status},
        gong_request_body:assignment, gong_response_body:result,
      };
    },
  };
}
