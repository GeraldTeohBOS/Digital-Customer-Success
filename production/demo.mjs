import {readFile} from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";
import {createApp} from "./app.mjs";
import {webConfig} from "./config.mjs";
import {simulatedGong} from "./gong.mjs";
import {listen} from "./http.mjs";
import {applySnapshot} from "./ingest.mjs";

const port = Number(process.env.DEMO_PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("DEMO_PORT must be a valid port.");
const origin = "http://127.0.0.1:" + port;
const config = {...webConfig({PUBLIC_URL:"https://example.com",OIDC_ISSUER:"https://identity.example.com",
  OIDC_CLIENT_ID:"demo",OIDC_CLIENT_SECRET:"demo-only"}),origin,demo:true,allowedOrigins:[origin]};
const userId = "demo-morgan";
const demoToken = "endor-local-demo-read";
const identity = {
  start({state}) { return origin + "/oidc/callback?" + new URLSearchParams({state,code:"demo-only"}); },
  async finish(url,{state}) {
    if (url.searchParams.get("state") === state && url.searchParams.get("code") === "demo-only") return userId;
  },
  async verify(token) { return token === demoToken ? {userId} : {error:"invalid_token"}; },
};
const database = new PGlite();
await database.exec(await readFile(new URL("./schema.sql",import.meta.url),"utf8"));
const query = (sql,args) => database.query(sql,args);
const pool = {query,async connect(){return {query,release(){}};}};
const accountId = "001000000000001AAA";
const contactId = "003000000000001AAA";
const seededAt = new Date().toISOString();
await applySnapshot(pool,{
  accountId,startedAt:seededAt,
  account:{Id:accountId,Name:"Copperline CRM Sandbox",SystemModstamp:seededAt},
  contacts:[{Id:contactId,AccountId:accountId,Name:"Jo Mercer",Title:"Platform Engineering",SystemModstamp:seededAt}],
});
await query("INSERT INTO cs_pilot.account_access VALUES ($1,$2)",[userId,accountId]);
const app = await createApp(pool,config,identity,simulatedGong({accountId,contactId,userId}));
const server = listen(app,{origin,port,host:"127.0.0.1"});
server.once("listening",()=>console.log("Local demo: " + origin + " (fictional data, Gong simulation)"));
for (const signal of ["SIGINT","SIGTERM"]) process.once(signal,()=>server.close(()=>database.close()));
