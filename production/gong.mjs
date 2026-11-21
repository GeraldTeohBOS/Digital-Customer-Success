import {emailBodyHtml} from "../src/email-copy.mjs";
import {RequestError} from "../src/service.mjs";
import {required,httpsUrl} from "./config.mjs";
import {checkAccountIds} from "./ingest.mjs";

const assignmentPath = "/v2/flows/prospects/assign";
const lockedFields = new Set(["crmProspectsIds","flowId","flowInstanceOwnerEmail","__proto__","constructor","prototype"]);
const markerSubject = "$approved_subject";
const markerBody = "$approved_body_html";

function compileOverrides(text) {
  const template = JSON.parse(text);
  if (template === null || typeof template !== "object" || Array.isArray(template) ||
      Object.keys(template).some(key => lockedFields.has(key))) {
    throw new Error("The Gong content template must be a JSON object without assignment routing fields.");
  }
  const markers = [0,0];
  const fill = (value,copy) => {
    if (value === markerSubject) { markers[0]++; return copy.subject; }
    if (value === markerBody) { markers[1]++; return copy.bodyHtml; }
    if (Array.isArray(value)) return value.map(item => fill(item,copy));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,fill(item,copy)]));
    }
    return value;
  };
  fill(template,{subject:"",bodyHtml:""});
  if (markers[0] !== 1 || markers[1] !== 1) {
    throw new Error("The Gong content template must contain one approved subject and one approved HTML body placeholder.");
  }
  return (subject,bodyHtml) => fill(template,{subject,bodyHtml});
}

const isTestTarget = (draft,userId,target) =>
  draft.account_id === target.accountId && draft.person_id === target.contactId && userId === target.userId;

function requireTestTarget(draft,userId,target) {
  if (!isTestTarget(draft,userId,target)) {
    throw new RequestError("Gong queueing is enabled only for the configured pilot operator and test contact.");
  }
}

function reply(status,requestId=null,instanceId=null) {
  return {status,requestId,instanceId};
}

export function simulatedGong({accountId,contactId,userId}) {
  const target = {accountId,contactId,userId,flowId:"demo-manual-email",ownerEmail:"morgan@endor-demo.example"};
  return {
    mode:"simulated",
    canAssign:(draft,actor) => isTestTarget(draft,actor,target),
    prepare(draft,actor) {
      requireTestTarget(draft,actor,target);
      return {flowId:target.flowId,ownerEmail:target.ownerEmail,draftId:draft.draft_id};
    },
    async assign(task) { return reply("queued","demo:" + task.draftId,"simulated:" + task.draftId); },
  };
}

export function configureGong(env = process.env,request = fetch) {
  const mode = env.GONG_MODE?.trim() || "disabled";
  if (mode === "disabled") return {mode};
  if (mode !== "live") throw new Error("GONG_MODE must be disabled or live.");
  if (env.GONG_MANUAL_FLOW_CONFIRMED !== "true") throw new Error("Confirm that the Gong pilot flow has exactly one manual email step.");
  const base = httpsUrl(required(env,"GONG_API_BASE_URL"),"GONG_API_BASE_URL",{originOnly:true});
  if (base.hostname !== "api.gong.io" && !base.hostname.endsWith(".api.gong.io")) throw new Error("Use the Gong API host from your workspace.");
  const [accountId] = checkAccountIds([required(env,"GONG_PILOT_ACCOUNT_ID")]);
  const [contactId] = checkAccountIds([required(env,"GONG_PILOT_CONTACT_ID")]);
  const target = {accountId,contactId,userId:required(env,"GONG_PILOT_USER_ID"),
    flowId:required(env,"GONG_MANUAL_FLOW_ID"),ownerEmail:required(env,"GONG_FLOW_OWNER_EMAIL")};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target.ownerEmail)) throw new Error("GONG_FLOW_OWNER_EMAIL must be a Gong user's email address.");
  const auth = "Basic " + Buffer.from(required(env,"GONG_ACCESS_KEY") + ":" + required(env,"GONG_ACCESS_KEY_SECRET")).toString("base64");
  const overrides = compileOverrides(required(env,"GONG_COPY_OVERRIDE_JSON"));

  return {
    mode:"live",
    canAssign:(draft,actor) => isTestTarget(draft,actor,target),
    prepare(draft,userId) {
      requireTestTarget(draft,userId,target);
      return {flowId:target.flowId,ownerEmail:target.ownerEmail, payload:{
        crmProspectsIds:[target.contactId],flowId:target.flowId,flowInstanceOwnerEmail:target.ownerEmail,
        ...overrides(draft.subject,emailBodyHtml(draft.body)),
      }};
    },
    async assign(task) {
      const response = await request(new URL(assignmentPath,base),{
        method:"POST",headers:{"Content-Type":"application/json",Authorization:auth},body:JSON.stringify(task.payload),
        redirect:"error",signal:AbortSignal.timeout(15000),
      });
      const result = await response.json().catch(() => null);
      const requestId = typeof result?.requestId === "string" ? result.requestId.slice(0,160) : null;
      if ([400,401,403,404,429].includes(response.status)) return reply("rejected",requestId);
      if (!response.ok) return reply("review_required",requestId);
      const assigned = result?.prospectsAssigned;
      const item = assigned?.[0];
      const rejected = result?.prospectsNotAssigned;
      if (Array.isArray(assigned) && assigned.length === 1 && (!rejected || rejected.length === 0) &&
          item.crmProspectId === target.contactId && item.flowId === target.flowId &&
          item.flowInstanceOwnerEmail?.toLowerCase() === target.ownerEmail.toLowerCase() &&
          typeof item.flowInstanceId === "string" && item.flowInstanceId.length > 0 && item.flowInstanceId.length <= 160) {
        return reply("queued",requestId,item.flowInstanceId);
      }
      if (Array.isArray(assigned) && assigned.length === 0 && Array.isArray(rejected) && rejected.length === 1 &&
          rejected[0]?.crmProspectId === target.contactId && rejected[0]?.flowId === target.flowId) {
        return reply("rejected",requestId);
      }
      return reply("review_required",requestId);
    },
  };
}
