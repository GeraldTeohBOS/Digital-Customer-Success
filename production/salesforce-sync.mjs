import {pathToFileURL} from "node:url";
import pg from "pg";
import {required, httpsUrl} from "./config.mjs";
import {applySnapshot, checkAccountIds} from "./ingest.mjs";

export async function syncSalesforce(pool, config, request = fetch) {
  const ids = checkAccountIds(config.accountIds);
  const origin = httpsUrl(config.origin,"SALESFORCE_BASE_URL",{originOnly:true}).origin;
  if (!/^v[0-9]+\.0$/.test(config.apiVersion)) throw new Error("Invalid Salesforce REST API version.");
  const apiRoot = "/services/data/" + config.apiVersion;
  async function read(path, errorLabel, init = {}) {
    const response = await request(new URL(path,origin),{...init,signal:AbortSignal.timeout(20000),redirect:"error"});
    if (!response.ok) throw new Error(errorLabel + " returned HTTP " + response.status + ".");
    return response.json();
  }
  const token = await read("/services/oauth2/token","Salesforce authentication",{
    method:"POST", body:new URLSearchParams({grant_type:"client_credentials",client_id:config.clientId,client_secret:config.clientSecret}),
  });
  if (typeof token.access_token !== "string" || !token.access_token) throw new Error("Salesforce returned no access token.");
  async function query(soql) {
    const records = [];
    let next = apiRoot + "/query?" + new URLSearchParams({q:soql});
    let advertisedCount;
    const followed = new Set();
    while (next) {
      if (followed.has(next)) throw new Error("Repeated Salesforce page token.");
      followed.add(next);
      const page = await read(next,"Salesforce query",{headers:{Authorization:"Bearer " + token.access_token}});
      if (!Array.isArray(page.records) || typeof page.done !== "boolean" || !Number.isInteger(page.totalSize) || page.totalSize < 0) {
        throw new Error("Salesforce returned an incomplete query page.");
      }
      advertisedCount ??= page.totalSize;
      records.push(...page.records);
      if (page.done) break;
      next = page.nextRecordsUrl;
      if (typeof next !== "string" || !next.startsWith(apiRoot + "/query/")) throw new Error("Missing or invalid Salesforce page URL.");
      if (new URL(next,origin).origin !== origin || !new URL(next,origin).pathname.startsWith(apiRoot + "/query/")) {
        throw new Error("Invalid Salesforce page target.");
      }
    }
    if (records.length !== advertisedCount) throw new Error("Salesforce paginated record count changed. Retry the sync.");
    return records;
  }
  const results = [];
  for (const accountId of ids) {
    const startedAt = new Date().toISOString();
    const [account] = await query("SELECT Id, Name, SystemModstamp FROM Account WHERE Id = '" + accountId + "'");
    const contacts = account ? await query("SELECT Id, AccountId, Name, Title, SystemModstamp FROM Contact WHERE AccountId = '" + accountId + "'") : [];
    results.push(await applySnapshot(pool,{accountId,account:account ?? null,contacts,startedAt}));
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const config = {
    origin:required(env,"SALESFORCE_BASE_URL"),
    clientId:required(env,"SALESFORCE_CLIENT_ID"),
    clientSecret:required(env,"SALESFORCE_CLIENT_SECRET"),
    accountIds:required(env,"PILOT_ACCOUNT_IDS").split(",").map(id => id.trim()),
    apiVersion:env.SALESFORCE_API_VERSION || "v66.0",
  };
  const pool = new pg.Pool({connectionString:env.INGEST_DATABASE_URL || required(env,"DATABASE_URL")});
  try {
    const results = await syncSalesforce(pool,config);
    const visible = results.filter(row => row.source_visible).length;
    const changes = results.reduce((total,row) => total + row.changed,0);
    console.log(`Salesforce sync finished. ${visible} visible accounts, ${changes} account or contact changes.`);
    if (!visible && results.some(row => row.source_visible === false)) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
