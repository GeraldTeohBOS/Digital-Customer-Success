import { createServer } from "node:http";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { openCanonicalDatabase } from "./sqlite.mjs";
import { createService } from "./service.mjs";
import { createDispatcher, handleMcp, rpcError } from "./mcp.mjs";
import { gongDemoDatabasePath, startGongDemoWebhook } from "./gong-demo.mjs";

const {values:flags} = parseArgs({options:{
  http:{type:"boolean",default:false}, port:{type:"string",default:"8765"}, db:{type:"string"},
  write:{type:"boolean",default:false}, "gong-demo":{type:"boolean",default:false}, help:{type:"boolean"},
}});
if (flags.help) {
  console.log("node src/server.mjs [--gong-demo | [--http] [--port 8765] [--db /path/to/canonical.sqlite3] [--write]]");
  process.exit(0);
}
const gongDemo = flags["gong-demo"];
if (gongDemo && (flags.http || flags.write || flags.db !== undefined)) {
  throw new Error("Use --gong-demo by itself. It uses stdio and creates its own fictional database copy.");
}
const token = process.env.ENDOR_CS_MCP_TOKEN;
if (flags.http && flags.write && !token) throw new Error("Set ENDOR_CS_MCP_TOKEN to enable HTTP action writes.");
const writable = gongDemo || flags.write;
const db = openCanonicalDatabase(gongDemo ? await gongDemoDatabasePath() : flags.db,{writable});
const ontology = JSON.parse(await readFile(new URL("../docs/ontology.json",import.meta.url),"utf-8"));
const gong = gongDemo ? await startGongDemoWebhook() : undefined;
const dispatch = createDispatcher(createService(db,ontology,{gong}),{actorId:writable ? "local-operator" : null});

if (flags.http) {
  const port = Number(flags.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid listen port.");
  const origins = (process.env.ENDOR_CS_ALLOWED_ORIGINS ?? "").split(",").map(x => x.trim()).filter(Boolean);
  const server = createServer(async (incoming,outgoing) => {
    try {
      // The process is loopback-only. A public connection needs a trusted HTTPS gateway.
      const address = new URL(incoming.url ?? "/", "http://127.0.0.1:" + port);
      if (address.pathname === "/health" && incoming.method === "GET") {
        const version = db.all("SELECT snapshot_id, as_of_utc FROM dataset_version")[0];
        outgoing.writeHead(200,{"Content-Type":"application/json","Cache-Control":"no-store"}).end(JSON.stringify(version));
        return;
      }
      if (address.pathname !== "/mcp") { outgoing.writeHead(404).end(); return; }
      const supplied = Buffer.from(incoming.headers.authorization ?? "");
      const expected = token ? Buffer.from("Bearer " + token) : null;
      if (expected && (expected.length !== supplied.length || !timingSafeEqual(supplied,expected))) {
        outgoing.writeHead(401,{"WWW-Authenticate":"Bearer"}).end();
        return;
      }
      const stream = incoming.method === "POST" ? Readable.toWeb(incoming) : undefined;
      const request = new Request(address, {method:incoming.method,headers:incoming.headers,body:stream,
        ...(stream ? {duplex:"half"} : {})});
      const response = await handleMcp(request,dispatch,origins);
      outgoing.writeHead(response.status,Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error("HTTP error:",error.message);
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end();
    }
  });
  server.listen(port,"127.0.0.1",() => console.error("MCP endpoint http://127.0.0.1:" + port + "/mcp"));
  process.on("SIGTERM",() => server.close(() => { db.close(); process.exit(0); }));
} else {
  const lines = createInterface({input:process.stdin,crlfDelay:Infinity});
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let request;
      try { request = JSON.parse(line); }
      catch { console.log(JSON.stringify(rpcError(null,-32700,"Invalid JSON."))); continue; }
      const response = await dispatch(request);
      if (response) console.log(JSON.stringify(response));
    }
  } finally {
    db.close();
    await gong?.close();
  }
}
