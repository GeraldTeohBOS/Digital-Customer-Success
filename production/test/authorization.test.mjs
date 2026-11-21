import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createHash,randomUUID} from "node:crypto";
import {PGlite} from "@electric-sql/pglite";
import {changeAccountRole} from "../access.mjs";
import {createApp} from "../app.mjs";
import {webConfig} from "../config.mjs";
import {applySnapshot} from "../ingest.mjs";

const schema = await readFile(new URL("../schema.sql",import.meta.url),"utf8");
const accountId = "001000000000001AAA";
const otherAccount = "001000000000002AAA";
const personId = "003000000000001AAA";
const timestamp = "2026-11-20T12:00:00Z";
async function fixture(t,sql = schema) {
  const database = new PGlite();
  t.after(()=>database.close());
  await database.exec(sql);
  const query = (statement,args) => database.query(statement,args);
  const pool = {query,async connect(){return {query,release(){}};}};
  for (const [id,name,contacts] of [[accountId,"Copperline",[
    {Id:personId,Name:"Pilot Contact",AccountId:accountId,SystemModstamp:timestamp},
  ]],[otherAccount,"Stratos",[]]]) {
    await applySnapshot(pool,{accountId:id,startedAt:timestamp,
      account:{Id:id,Name:name,SystemModstamp:timestamp},contacts});
  }
  return {database,pool,query};
}

test("browser and MCP enforce account roles on discovery, records and mutations",async t=>{
  const {pool,query} = await fixture(t);
  const actors = new Map(["viewer","author","admin","other","new"].map((id,index)=>[id,String(index).repeat(43)]));
  for (const [userId,account,role] of [
    ["viewer",accountId,"viewer"],["author",accountId,"csm"],["author",accountId,"approver"],
    ["admin",accountId,"access_admin"],["other",otherAccount,"approver"],
  ]) {
    await changeAccountRole(pool,"test",{operation:"grant",account_id:account,user_id:userId,role},{bootstrap:true});
  }
  for (const [actor,session] of actors) {
    await query("INSERT INTO cs_pilot.web_session VALUES ($1,$2,now()+interval '1 hour')",
      [createHash("sha256").update(session).digest("hex"),actor]);
  }
  const config = webConfig({PUBLIC_URL:"https://cs.example",OIDC_ISSUER:"https://auth.example",
    OIDC_CLIENT_ID:"test",OIDC_CLIENT_SECRET:"demo-only"});
  const app = await createApp(pool,config,{verify:async token => actors.has(token) ? {userId:token} : {error:"invalid_token"}});
  const call = async (actor,path,data,origin=config.origin) => {
    const response = await app(new Request(config.origin + path,{
      method:data === undefined ? "GET" : "POST",
      headers:{Origin:origin,"Content-Type":"application/json",...(
        path === "/mcp" ? {Authorization:"Bearer " + actor} : {Cookie:"__Host-endor-session=" + actors.get(actor)}
      )},
      body:data === undefined ? undefined : JSON.stringify(data),
    }));
    return {status:response.status,...await response.json()};
  };
  const rpc = (name,args) => ({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}});
  const tools = actor => call(actor,"/mcp",{jsonrpc:"2.0",id:1,method:"tools/list"});
  for (const actor of ["new","admin"]) assert.deepEqual((await tools(actor)).result.tools,[]);
  assert.equal((await tools("viewer")).result.tools.length,5);
  assert.equal((await tools("author")).result.tools.length,7);
  assert((await tools("author")).result.tools.every(tool=>tool.annotations.readOnlyHint));

  const id = randomUUID();
  const create = {operation:"create",draft:{draft_id:id,account_id:accountId,person_id:personId,subject:"Private draft",body:"Test body"}};
  assert.equal((await call("viewer","/api/outreach",create)).status,403);
  assert.equal((await call("author","/api/outreach",create)).status,200);
  const getDraft = rpc("get_outreach_draft",{draft_id:id});
  assert.equal((await call("viewer","/api/console",getDraft)).result.isError,true);
  assert.equal((await call("viewer","/mcp",getDraft)).error.code,-32602);
  assert.equal((await call("other","/mcp",getDraft)).result.isError,true);
  assert.equal((await call("admin","/api/console",rpc("get_account",{account:accountId}))).result.isError,true);
  const approve = {operation:"approve",draft:{draft_id:id,expected_revision:1}};
  assert.equal((await call("author","/api/outreach",approve)).status,403);
  assert.equal((await call("other","/api/outreach",approve)).status,403);
  assert.deepEqual((await query("SELECT approved_by FROM cs_pilot.outreach_draft WHERE draft_id=$1",[id])).rows,
    [{approved_by:null}]);

  const scopes = await call("admin","/api/access");
  assert.deepEqual(scopes.accounts,[{account_id:accountId}]);
  const scopePath = "/api/access?account_id=" + accountId;
  assert.equal((await call("author",scopePath)).status,403);
  assert.equal((await call("admin","/api/access?account_id=" + otherAccount)).status,403);
  const grant = {operation:"grant",account_id:accountId,user_id:"viewer",role:"approver"};
  assert.equal((await call("author","/api/access",grant)).status,403);
  assert.equal((await call("admin","/api/access",{...grant,user_id:"admin"})).status,403);
  assert.equal((await call("admin","/api/access",{...grant,role:"access_admin"})).status,403);
  assert.equal((await call("admin","/api/access",{...grant,account_id:otherAccount})).status,403);
  assert.equal((await call("admin","/api/access",grant,"https://elsewhere.example")).status,403);
  assert.equal((await call("admin","/api/access",grant)).changed,true);
  assert.equal((await call("admin","/api/access",grant)).changed,false);
  assert.equal((await call("viewer","/mcp",getDraft)).result.structuredContent.draft.can_approve,true);
  assert.equal((await call("viewer","/api/console",getDraft)).result.structuredContent.draft.body,"Test body");
  assert.equal((await call("admin","/api/access",{...grant,operation:"revoke"})).changed,true);
  assert.equal((await call("viewer","/api/outreach",approve)).status,403);
  assert.equal((await call("viewer","/mcp",getDraft)).error.code,-32602);
  assert.equal((await call("viewer","/api/console",getDraft)).result.isError,true);
  const history = (await call("admin",scopePath)).audit.filter(event => event.actor_id === "admin");
  assert.deepEqual(history.map(event=>[event.action,event.target_user_id,event.target_role]),[
    ["role.revoke","viewer","approver"],["role.grant","viewer","approver"],
  ]);
  assert(history.every(event=>!Object.hasOwn(event,"body")));
});

test("existing account access migrates once to Viewer and a revocation survives another migration",async t=>{
  const previous = schema.slice(0,schema.indexOf("CREATE TABLE IF NOT EXISTS cs_pilot.account_role_grant"));
  const {database,pool,query} = await fixture(t,previous);
  const userId = "legacy-user";
  await query("INSERT INTO cs_pilot.account_access (user_id,account_id) VALUES ($1,$2)",[userId,accountId]);
  await database.exec(schema);
  assert.deepEqual((await query("SELECT role FROM cs_pilot.account_role_grant WHERE user_id=$1",[userId])).rows,[{role:"viewer"}]);
  await changeAccountRole(pool,"test",{operation:"revoke",account_id:accountId,user_id:userId,role:"viewer"},{bootstrap:true});
  await database.exec(schema);
  assert.equal((await query("SELECT role FROM cs_pilot.account_role_grant WHERE user_id=$1",[userId])).rows.length,0);
});
