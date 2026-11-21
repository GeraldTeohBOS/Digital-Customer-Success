import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";
import {createLocalJWKSet,exportJWK,generateKeyPair,SignJWT} from "jose";
import {createApp} from "../app.mjs";
import {verifyMcpToken} from "../auth.mjs";
import {webConfig} from "../config.mjs";
import {applySnapshot,checkAccountIds} from "../ingest.mjs";
import {syncSalesforce} from "../salesforce-sync.mjs";

test("a Salesforce change reaches the signed-in console and remote MCP through the same database", async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(await readFile(new URL("../schema.sql",import.meta.url),"utf8"));
  const query = (text,params) => db.query(text,params);
  const pool = {query,async connect() {return {query,release(){}};}};
  const accountId = "001000000000001AAA";
  const hiddenId = "001000000000002AAA";
  const contactId = "003000000000001AAA";
  const secondId = "003000000000002AAA";
  checkAccountIds([accountId.slice(0,15),accountId]).forEach(id => assert.equal(id,accountId));
  const initial = "2026-11-20T14:00:00Z";
  const modified = "2026-11-20T15:20:00Z";
  const salesforceConfig = {accountIds:[accountId.slice(0,15)],origin:"https://crm.example",clientId:"integration",
    clientSecret:"test-only",apiVersion:"v66.0"};
  const account = {Id:accountId,Name:"Copperline CRM Sandbox",SystemModstamp:initial};
  let contact = {Id:contactId,AccountId:accountId,Name:"Jo Mercer",Title:"Platform Engineer",SystemModstamp:initial};
  const secondContact = {Id:secondId,AccountId:accountId,Name:"Drew Ito",Title:"Evaluator",SystemModstamp:initial};
  let failPage = false;
  const page = (records,totalSize=records.length,nextRecordsUrl) =>
    Response.json({totalSize,records,done:!nextRecordsUrl,nextRecordsUrl});
  const mockSalesforce = async (url,init) => {
    if (url.pathname === "/services/oauth2/token") {
      assert.equal(init.body.get("grant_type"),"client_credentials");
      return Response.json({access_token:"salesforce-test"});
    }
    assert.equal(init.headers.Authorization,"Bearer salesforce-test");
    if (url.pathname.endsWith("/query/page-2")) return failPage ? new Response(null,{status:503}) : page([secondContact],2);
    const soql = url.searchParams.get("q");
    assert.match(soql,new RegExp(accountId));
    if (soql.includes("FROM Account")) return page([account]);
    return page([contact],2,"/services/data/v66.0/query/page-2");
  };
  assert.equal((await syncSalesforce(pool,salesforceConfig,mockSalesforce))[0].changed,3);
  await applySnapshot(pool,{accountId:hiddenId,account:{...account,Id:hiddenId,Name:"Restricted account"},
    contacts:[],startedAt:initial});
  await query("INSERT INTO cs_pilot.account_access VALUES ($1,$2)",["okta-user-1",accountId]);
  await query("INSERT INTO cs_pilot.account_access VALUES ($1,$2)",["okta-user-2",hiddenId]);

  const config = webConfig({PUBLIC_URL:"https://cs.example",OIDC_ISSUER:"https://issuer.example/oauth2/pilot",
    OIDC_CLIENT_ID:"web-test",OIDC_CLIENT_SECRET:"test-only"});
  const keys = await generateKeyPair("RS256");
  const jwks = createLocalJWKSet({keys:[await exportJWK(keys.publicKey)]});
  const sign = (uid,audience=config.resource,scope="cs.read") => new SignJWT({uid,scp:[scope]}).setProtectedHeader({alg:"RS256"})
    .setIssuer(config.mcpIssuer).setAudience(audience).setSubject("browser-user@example").setExpirationTime("5m").sign(keys.privateKey);
  const identity = {
    start({state,challenge}) {
      assert.equal(challenge.length,43);
      return "https://issuer.example/authorize?state=" + state;
    },
    async finish(url,{state,nonce,verifier}) {
      assert.equal(url.searchParams.get("state"),state);
      assert(nonce && verifier);
      return "okta-user-1";
    },
    verify:token => verifyMcpToken(token,jwks,config),
  };
  const app = await createApp(pool,config,identity);
  const request = (path,options) => app(new Request(config.origin + path,options));
  assert.equal((await request("/health")).status,200);
  assert.match(await (await request("/")).text(),/Sign in with Okta/);
  assert.equal((await request("/api/console",{method:"POST"})).status,401);
  const challenge = await request("/mcp",{method:"POST"});
  assert.equal(challenge.status,401);
  assert.match(challenge.headers.get("WWW-Authenticate"),/oauth-protected-resource\/mcp/);
  assert.equal((await (await request(config.metadataPath)).json()).resource,config.resource);
  const login = await request("/login");
  const state = new URL(login.headers.get("Location")).searchParams.get("state");
  const cookiePair = cookie => cookie.split(";")[0];
  const callback = await request("/oidc/callback?state=" + state + "&code=fake-code",{headers:{Cookie:cookiePair(login.headers.getSetCookie()[0])}});
  assert.equal(callback.headers.get("Location"),"/");
  const session = cookiePair(callback.headers.getSetCookie()[1]);
  assert.match(await (await request("/",{headers:{Cookie:session}})).text(),/Account activity/);
  const token = await sign("okta-user-1");
  const restricted = await sign("okta-user-2");
  const invoke = async (path,name,args = {},authorization=token,method="tools/call") => {
    const mcp = path === "/mcp";
    const response = await request(path,{method:"POST",headers:{"Content-Type":"application/json",
      ...(mcp ? {Authorization:"Bearer " + authorization, Origin:"https://chatgpt.com"} : {Cookie:session,Origin:config.origin})},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method,params:{name,arguments:args}})});
    return {status:response.status,body:await response.json()};
  };
  const data = async (path,name,args) => {
    const {status,body} = await invoke(path,name,args);
    assert.equal(status,200);
    assert(!body.result.isError,body.result.content?.[0]?.text);
    return body.result.structuredContent;
  };
  const tools = (await invoke("/mcp",undefined,{},token,"tools/list")).body.result.tools;
  assert.equal(tools.length,7);
  assert(tools.every(tool => tool.annotations.readOnlyHint));
  assert.equal((await invoke("/mcp","list_accounts",{},await sign("okta-user-1","https://another-api.example"))).status,401);
  assert.equal((await invoke("/mcp","list_accounts",{},await sign("okta-user-1",config.resource,"unrelated"))).status,403);
  assert.equal((await invoke("/mcp","get_account",{account:accountId},restricted)).body.result.isError,true);
  assert.deepEqual((await data("/api/console","list_accounts")).accounts.map(row => row.account_id),[accountId]);
  const args = {account:accountId};
  const before = await data("/api/console","get_knowledge_graph",args);
  assert.equal(before.nodes.find(node => node.id === contactId).subtitle,"Platform Engineer");

  contact = {...contact,Title:"Director of Platform Engineering",SystemModstamp:modified};
  failPage = true;
  await assert.rejects(syncSalesforce(pool,salesforceConfig,mockSalesforce),/503/);
  assert.equal((await data("/api/console","get_knowledge_graph",args)).nodes.length,3);
  assert.equal((await data("/mcp","list_timeline",args)).events.length,3);
  failPage = false;
  assert.equal((await syncSalesforce(pool,salesforceConfig,mockSalesforce))[0].changed,1);
  assert.equal((await syncSalesforce(pool,salesforceConfig,mockSalesforce))[0].changed,0);

  const [browser,mcp,graph] = await Promise.all([
    data("/api/console","list_timeline",args),data("/mcp","list_timeline",args),data("/api/console","get_knowledge_graph",args),
  ]);
  assert.equal(browser.events.length,4);
  assert.deepEqual(browser.events,mcp.events);
  assert.equal(browser.events[0].event_kind,"contact_updated");
  assert.match(browser.events[0].summary,/Director of Platform Engineering/);
  assert.equal(browser.freshness.synced_at,mcp.freshness.synced_at);
  assert.equal(graph.nodes.find(node => node.id === contactId).subtitle,"Director of Platform Engineering");
  const eventArgs = {event_id:browser.events[0].event_id};
  assert.equal((await data("/mcp","get_event",eventArgs)).event.event_id,eventArgs.event_id);
  assert.equal((await invoke("/mcp","get_event",eventArgs,restricted)).body.result.isError,true);

  const stale = await applySnapshot(pool,{accountId,account,contacts:[],startedAt:initial});
  assert.equal(stale.skipped,"older_sync");
  await query("DELETE FROM cs_pilot.account_access WHERE user_id=$1 AND account_id=$2",["okta-user-1",accountId]);
  assert.equal((await invoke("/api/console","get_account",args)).body.result.isError,true);
  assert.equal((await invoke("/mcp","get_event",eventArgs)).body.result.isError,true);
});
