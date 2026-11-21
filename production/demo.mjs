import {readFile} from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";
import {createApp} from "./app.mjs";
import {webConfig} from "./config.mjs";
import {simulatedGong} from "./gong.mjs";
import {listen} from "./http.mjs";
import {applySnapshot} from "./ingest.mjs";
import {changeAccountRole} from "./access.mjs";

const port = Number(process.env.DEMO_PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("DEMO_PORT must be a valid port.");
const origin = "http://127.0.0.1:" + port;
const personas = [
  {id:"morgan",label:"Morgan · CSM",role:"csm"},
  {id:"avery",label:"Avery · Approver",role:"approver"},
  {id:"jordan",label:"Jordan · Gong operator",role:"gong_operator"},
  {id:"riley",label:"Riley · Viewer",role:"viewer"},
  {id:"sam",label:"Sam · Access admin",role:"access_admin"},
];
const config = {...webConfig({PUBLIC_URL:"https://example.com",OIDC_ISSUER:"https://identity.example.com",
  OIDC_CLIENT_ID:"demo",OIDC_CLIENT_SECRET:"demo-only"}),origin,demo:{personas},allowedOrigins:[origin]};
const demoUser = name => personas.some(persona => persona.id === name) ? "demo-" + name : null;
const identity = {
  start({state,persona}) {
    return origin + "/oidc/callback?" + new URLSearchParams({state,code:demoUser(persona) ? persona : "morgan"});
  },
  async finish(url,{state}) {
    if (url.searchParams.get("state") === state) return demoUser(url.searchParams.get("code"));
  },
  async verify(token) {
    const name = token === "endor-local-demo-read" ? "morgan" : /^endor-local-demo-([a-z]+)$/.exec(token)?.[1];
    const userId = demoUser(name);
    return userId ? {userId} : {error:"invalid_token"};
  },
};
const database = new PGlite();
await database.exec(await readFile(new URL("./schema.sql",import.meta.url),"utf8"));
const query = (sql,args) => database.query(sql,args);
const pool = {query,async connect(){return {query,release(){}};}};
const accountId = "001000000000001AAA";
const secondAccount = "001000000000002AAA";
const contactId = "003000000000001AAA";
const seededAt = new Date().toISOString();
await applySnapshot(pool,{
  accountId,startedAt:seededAt,
  account:{Id:accountId,Name:"Copperline CRM Sandbox",SystemModstamp:seededAt},
  contacts:[{Id:contactId,AccountId:accountId,Name:"Jo Mercer",Title:"Platform Engineering",SystemModstamp:seededAt}],
});
await applySnapshot(pool,{
  accountId:secondAccount,startedAt:seededAt,
  account:{Id:secondAccount,Name:"Stratos CRM Sandbox",SystemModstamp:seededAt},contacts:[],
});
for (const {id,role} of personas) {
  await changeAccountRole(pool,"demo:setup",{operation:"grant",user_id:demoUser(id),account_id:accountId,role},{bootstrap:true});
}
await changeAccountRole(pool,"demo:setup",{operation:"grant",user_id:demoUser("sam"),account_id:secondAccount,role:"access_admin"},{bootstrap:true});
const app = await createApp(pool,config,identity,simulatedGong({accountId,contactId,userId:demoUser("jordan")}));
const server = listen(app,{origin,port,host:"127.0.0.1"});
server.once("listening",()=>console.log("Local demo: " + origin + " (fictional data, Gong simulation)"));
for (const signal of ["SIGINT","SIGTERM"]) process.once(signal,()=>server.close(()=>database.close()));
