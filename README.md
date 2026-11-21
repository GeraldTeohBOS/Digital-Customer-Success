# Digital Customer Success pilot

Explore account and contact changes, approve an outreach draft, and queue a manual Gong email task. This Endor Labs concept includes fictional demo data and a separate path for a workplace sandbox.

## Run the demo

Use Node.js 24 or newer. Run these commands from the repository root.

```sh
npm --prefix production ci
npm --prefix production run demo
```

Open [the local console](http://127.0.0.1:8080) and select **Open demo**. Choose **Copperline CRM Sandbox** and use **Gong outreach** to save a draft for Jo Mercer. Edit and save the copy, approve the saved version, then click **Simulate Gong queue**. The console displays the simulated flow instance. The demo runs on your machine with an in-memory database and a Gong simulator. Restarting it resets the test data.

Try editing the subject before approval. The console asks you to save the revised copy first. After approval, check that the subject and body are locked and the queue action records one assignment. If you test the project for someone else, report the step you tried, the outcome you expected, and what you observed.

### Try the MCP endpoint locally

While the demo is running, this call lists the saved assignments.

```sh
curl http://127.0.0.1:8080/mcp \
  -H 'Authorization: Bearer endor-local-demo-read' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_outreach_drafts","arguments":{"account":"Copperline CRM Sandbox"}}}'
```

The token belongs to the local fixture. Use the OAuth setup in the deployment guide to connect Claude or ChatGPT to a hosted endpoint.

## Share on GitHub

Extract the ZIP and use the folder containing this README as the repository root. Push the extracted files, including `.github/workflows/`, so pull requests can run the pilot tests. Share the repository URL and point reviewers to **Run the demo**. [GitHub guide to adding local code](https://docs.github.com/en/repositories/creating-and-managing-repositories/adding-locally-hosted-code-to-github)

```sh
npm --prefix production test
```

## Deploy to a workplace sandbox

Follow [the deployment guide](production/README.md) for PostgreSQL, Okta, Salesforce synchronization, and remote MCP. Its **Live Gong acceptance test** covers one approved contact and a one-step manual flow. Inspect the exact approved subject and body in Gong before using a live task.

## Explore the original demo

| Path | Use |
|---|---|
| `visual/Endor_CS_Knowledge_Graph.html` | Open the standalone graph of accounts, buying groups, evidence, actions, and proposed outreach. |
| `docs/Endor_CS_Business_Ontology.md` | Read definitions, evidence rules, and dataset relationships. |
| `data/canonical.sqlite3` and `data/csv/` | Inspect the fictional SQLite data and table and view exports. |
| `src/server.mjs` | Connect the original local demo to Claude Desktop using `claude_desktop_config.example.json`. |

The original demo uses local SQLite and simulated provider inputs. Use `node src/server.mjs` for stdio or add `--http` for a loopback HTTP MCP endpoint. It opens read-only by default. Add `--write --db <writable-sqlite-file>` to record changes in a copy, and set `ENDOR_CS_MCP_TOKEN` if using writable HTTP. [Claude Desktop local MCP setup](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)

Run `python3 data/build_database.py` and `node scripts/export-graph.mjs` to rebuild the original fixture and graph exports. The cloud pilot uses `production/schema.sql`.
