import test from "node:test";
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";
import {createApp} from "../app.mjs";
import {webConfig} from "../config.mjs";
import {configureGong} from "../gong.mjs";
import {applySnapshot} from "../ingest.mjs";

const accountId = "001000000000001AAA";
const personId = "003000000000001AAA";
const otherId = "003000000000002AAA";
const userId = "pilot-operator";
const authorId = "pilot-author";
const approverId = "pilot-reviewer";
const env = {
  GONG_MODE:"live",GONG_MANUAL_FLOW_CONFIRMED:"true",GONG_API_BASE_URL:"https://api.gong.io",
  GONG_PILOT_ACCOUNT_ID:accountId,GONG_PILOT_CONTACT_ID:personId,GONG_PILOT_USER_ID:userId,
  GONG_MANUAL_FLOW_ID:"manual-flow-qa",GONG_FLOW_OWNER_EMAIL:"morgan@example.com",
  GONG_ACCESS_KEY:"fixture-key",GONG_ACCESS_KEY_SECRET:"fixture-secret",
  // These fields belong to the local API fixture. Live deployments supply their confirmed Gong request fields.
  GONG_COPY_OVERRIDE_JSON:'{"fixtureStep":{"number":1,"subject":"$approved_subject","bodyHtml":"$approved_body_html"}}',
};
const goodResponse = () => Response.json({requestId:"request-qa",prospectsNotAssigned:[],
  prospectsAssigned:[{crmProspectId:personId,flowId:env.GONG_MANUAL_FLOW_ID,
    flowInstanceOwnerEmail:env.GONG_FLOW_OWNER_EMAIL,flowInstanceId:"flow-instance-qa"}]});

test("a manual Gong handoff pins the approved copy and reserves one request",async t=>{
  const database = new PGlite();
  t.after(()=>database.close());
  await database.exec(await readFile(new URL("../schema.sql",import.meta.url),"utf8"));
  const query = (sql,args) => database.query(sql,args);
  const pool = {query,async connect(){return {query,release(){}};}};
  const startedAt = new Date().toISOString();
  await applySnapshot(pool,{accountId,startedAt,account:{Id:accountId,Name:"Copperline CRM Sandbox",SystemModstamp:startedAt},
    contacts:[{Id:personId,AccountId:accountId,Name:"Jo Mercer",SystemModstamp:startedAt},
      {Id:otherId,AccountId:accountId,Name:"Other Contact",SystemModstamp:startedAt}]});
  const sessions = new Map([[authorId,"a".repeat(43)],[approverId,"b".repeat(43)],[userId,"s".repeat(43)]]);
  for (const [actor,role] of [[authorId,"csm"],[approverId,"approver"],[userId,"gong_operator"]]) {
    await query(`INSERT INTO cs_pilot.account_role_grant (user_id,account_id,role,granted_by) VALUES ($1,$2,$3,'test')`,
      [actor,accountId,role]);
    await query("INSERT INTO cs_pilot.web_session VALUES ($1,$2,now()+interval '1 hour')",
      [createHash("sha256").update(sessions.get(actor)).digest("hex"),actor]);
  }
  const config = webConfig({PUBLIC_URL:"https://cs.example",OIDC_ISSUER:"https://auth.example",
    OIDC_CLIENT_ID:"test",OIDC_CLIENT_SECRET:"demo-only"});
  const identity = {verify:async()=>({userId})};
  let calls = 0;
  let release;
  let markCalled;
  const accepted = new Promise(resolve=>{ release = resolve; });
  const called = new Promise(resolve=>{ markCalled = resolve; });
  const deliveries = [];
  const gong = configureGong(env,async (url,options)=>{
    calls++;
    deliveries.push({url,options,payload:JSON.parse(options.body)});
    markCalled();
    await accepted;
    return goodResponse();
  });
  const app = await createApp(pool,config,identity,gong);
  async function mutate(operation,draft,{origin=config.origin,actor=authorId} = {}) {
    const result = await app(new Request(config.origin + "/api/outreach",{method:"POST",
      headers:{Origin:origin,Cookie:"__Host-endor-session=" + sessions.get(actor),"Content-Type":"application/json"},
      body:JSON.stringify({operation,draft})}));
    return {status:result.status,result:await result.json()};
  }
  const id = randomUUID();
  const create = {draft_id:id,account_id:accountId,person_id:personId,subject:"First draft",body:"Hi Jo,\n\nInitial copy."};
  assert.equal((await mutate("create",create,{origin:"https://another.example"})).status,403);
  const saved = await mutate("create",create);
  assert.equal(saved.status,200,saved.result.error);
  assert.equal(saved.result.draft.revision,1);
  assert.equal((await mutate("queue",{draft_id:id,expected_revision:1},{actor:userId})).status,400);
  assert.equal((await mutate("queue",{draft_id:id,expected_revision:1})).status,403);
  assert.equal(calls,0);
  const subject = "Could we test Java & Go?";
  const body = "Hi Jo,\n\nPlease compare <two templates>.\n\nMorgan";
  const edited = await mutate("edit",{draft_id:id,expected_revision:1,subject,body});
  assert.equal(edited.result.draft.revision,2);
  assert.equal((await mutate("approve",{draft_id:id,expected_revision:1},{actor:approverId})).status,400);
  const approved = (await mutate("approve",{draft_id:id,expected_revision:2},{actor:approverId})).result.draft;
  assert.equal(approved.status,"approved");
  assert.equal(approved.revision,3);
  assert.equal((await mutate("edit",{draft_id:id,expected_revision:3,subject:"After approval",body})).status,400);
  const wrong = randomUUID();
  await mutate("create",{...create,draft_id:wrong,person_id:otherId});
  await mutate("approve",{draft_id:wrong,expected_revision:1},{actor:approverId});
  assert.equal((await mutate("queue",{draft_id:wrong,expected_revision:2},{actor:userId})).status,400);
  assert.equal(calls,0);
  const request = {draft_id:id,expected_revision:3};
  const first = mutate("queue",request,{actor:userId});
  await Promise.race([called,first.then(result=>Promise.reject(new Error("Expected Gong request: " + JSON.stringify(result))))]);
  const repeated = await mutate("queue",request,{actor:userId});
  assert.equal(repeated.result.draft.status,"processing");
  assert.equal(calls,1);
  release();
  const ready = (await first).result.draft;
  assert.equal(ready.status,"queued");
  assert.equal(ready.flow_instance_id,"flow-instance-qa");
  assert.equal(ready.body,body);
  const [{url,options,payload}] = deliveries;
  assert.equal(url.href,"https://api.gong.io/v2/flows/prospects/assign");
  assert.match(options.headers.Authorization,/^Basic /);
  assert.deepEqual(payload.crmProspectsIds,[personId]);
  assert.equal(payload.fixtureStep.subject,subject);
  assert.equal(payload.fixtureStep.bodyHtml,"<p>Hi Jo,</p><p>Please compare &lt;two templates&gt;.</p><p>Morgan</p>");
  const result = await app(new Request(config.origin + "/mcp",{method:"POST",headers:{
    Authorization:"Bearer test","Content-Type":"application/json"},body:JSON.stringify({
    jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"get_outreach_draft",arguments:{draft_id:id}},
  })}));
  const mcpDraft = (await result.json()).result.structuredContent.draft;
  assert.equal(mcpDraft.flow_instance_id,ready.flow_instance_id);
  assert.equal(mcpDraft.status,"queued");
  const audit = (await query(`SELECT actor_id,action,revision FROM cs_pilot.authorization_audit
    WHERE draft_id=$1 ORDER BY audit_id`,[id])).rows;
  assert.deepEqual(audit.map(event=>[event.actor_id,event.action,event.revision]),[
    [authorId,"outreach.create",1],[authorId,"outreach.edit",2],[approverId,"outreach.approve",3],
    [userId,"gong.request",3],[userId,"gong.queued",3],
  ]);
  const second = randomUUID();
  await mutate("create",{...create,draft_id:second});
  await mutate("approve",{draft_id:second,expected_revision:1},{actor:approverId});
  assert.equal((await mutate("queue",{draft_id:second,expected_revision:2},{actor:userId})).status,400);
  assert.equal(calls,1);
});

test("Gong adapter requires a confirmed copy mapping and treats ambiguous confirmations as review",async()=>{
  assert.throws(()=>configureGong({...env,GONG_COPY_OVERRIDE_JSON:'{"other":"$approved_subject"}'}),/placeholder/);
  assert.throws(()=>configureGong({...env,GONG_MANUAL_FLOW_CONFIRMED:"false"}),/manual email step/);
  const draft = {account_id:accountId,person_id:personId,subject:"Subject",body:"Hello."};
  const invalid = configureGong(env,async()=>Response.json({
    prospectsAssigned:[{flowInstanceId:"unknown-prospect",crmProspectId:otherId,flowId:env.GONG_MANUAL_FLOW_ID}]}));
  assert.equal((await invalid.assign(invalid.prepare(draft,userId))).status,"review_required");
  const denied = configureGong(env,async()=>Response.json({prospectsAssigned:[],
    prospectsNotAssigned:[{crmProspectId:personId,flowId:env.GONG_MANUAL_FLOW_ID}]}));
  assert.equal((await denied.assign(denied.prepare(draft,userId))).status,"rejected");
});
