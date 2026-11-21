const textResponse = (value,status=200) => new Response(value,{
  status,headers:{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store"},
});
const pageResponse = value => new Response(value,{
  headers:{"Content-Type":"text/html; charset=utf-8","X-Content-Type-Options":"nosniff","Cache-Control":"no-store"},
});
const consoleTools = new Set(["list_outreach_drafts","get_outreach_draft","save_outreach_draft","update_outreach_draft",
  "list_timeline","get_event","describe_dataset"]);

export default {
  async fetch(request,env) {
    const url = new URL(request.url);
    const database = env.DB;
    if (!database) return textResponse("Canonical database binding is unavailable.",503);
    const all = async (sql,values=[]) => {
      const statement = database.prepare(sql);
      const result = await (values.length ? statement.bind(...values) : statement).all();
      return result.results;
    };
    const write = async (sql,values) => (await database.prepare(sql).bind(...values).run()).meta.changes;
    const ready = async () => (await all("SELECT snapshot_id, as_of_utc FROM dataset_version"))[0];

    // Initialize or upgrade the demo in one transaction under the Site's access gate.
    // Keep the source snapshot and its seed actions current alongside the live register.
    async function initializeSnapshot() {
      const current = await ready();
      if (current?.snapshot_id === SITE_SEED.snapshot_id) return;
      const plan = current ? SITE_SEED.upgrades[current.snapshot_id] : SITE_SEED.fresh;
      if (!Array.isArray(plan)) throw new Error("Unexpected starting snapshot for the customer workflow migration.");
      const operations = plan.map(({sql, values}) => {
        const statement = database.prepare(sql);
        return values.length ? statement.bind(...values) : statement;
      });
      await database.batch(operations);
    }

    const actorId = request.headers.get("oai-authenticated-user-id");
    if (url.pathname === "/mcp") {
      const dispatch = createDispatcher(createService({all,write},SITE_ONTOLOGY),{actorId});
      const connection = async (message,version) => {
        if (message?.jsonrpc === "2.0" && ["server/discover","initialize","tools/list","tools/call"].includes(message.method)) {
          await initializeSnapshot();
        }
        return dispatch(message,version);
      };
      return handleMcp(request,connection,["https://chatgpt.com"]);
    }
    if (url.pathname === "/api/console" && request.method === "POST") {
      if (!actorId) return textResponse("Sign in to the console to continue.",401);
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) return textResponse("Open the workflow from the console.",403);
      if (!request.headers.get("Content-Type")?.startsWith("application/json")) return textResponse("Expected JSON.",415);
      let message;
      try { message = await readJSON(request); }
      catch { return textResponse("Invalid console request.",400); }
      if (message?.method !== "tools/call" || !consoleTools.has(message.params?.name)) {
        return textResponse("Unknown console operation.",400);
      }
      await initializeSnapshot();
      const dispatch = createDispatcher(createService({all,write},SITE_ONTOLOGY),{actorId});
      return Response.json(await dispatch(message),{headers:{"Cache-Control":"no-store"}});
    }
    if (url.pathname === "/health" && request.method === "GET") {
      const metadata = await ready();
      return Response.json({ready:Boolean(metadata),...metadata},{headers:{"Cache-Control":"no-store"}});
    }
    if (url.pathname === "/" && request.method === "GET") {
      await initializeSnapshot();
      return pageResponse(SITE_GRAPH.replace("<body>",'<body data-live-console="true">'));
    }
    return textResponse("Page not found.",404);
  }
};
