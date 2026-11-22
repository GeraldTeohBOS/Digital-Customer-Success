# Digital Customer Success pilot

Explore account and contact changes, approve an outreach draft, and queue a manual Gong email task. This Endor Labs concept includes fictional demo data and a separate path for a workplace sandbox.

## Test the demo

Use Node.js 24 or newer. Run these commands from the repository root.

```sh
npm --prefix production ci
npm --prefix production run demo
```

Open [the local console](http://127.0.0.1:8080). The demo uses fictional data and a Gong simulator and needs no workplace credentials. Use **Sign out** to switch personas while keeping the same data. Restarting the demo resets all drafts and role changes.

| Sign in as | What to do | Expected result |
|---|---|---|
| **Morgan · CSM** | Choose **Copperline CRM Sandbox**. Under **Gong outreach**, save a draft for Jo Mercer and edit the subject. | Morgan can edit the saved draft. Approval and queueing require another role. |
| **Avery · Approver** | Open Morgan’s draft from **Saved drafts**. Select **Approve saved copy**. | The exact saved subject and body are read-only and the status becomes **Approved**. |
| **Jordan · Gong operator** | Open the approved draft and select **Simulate Gong queue**. Reopen the draft. | The status is **Manual task queued** with one simulated flow instance ID. |
| **Riley · Viewer** | Open the Copperline timeline and account graph. | Riley sees account activity. Drafts and the access administration panel are hidden. |
| **Sam · Access admin** | Under **Account access**, choose `001000000000002AAA` (Stratos). Grant **Viewer** to `demo-riley`, then sign in as Riley to check the account picker. Sign back in as Sam and revoke the grant. | Stratos appears for Riley after the grant and disappears after revocation. Sam can see both changes in the account audit log. |

Run the automated tests with `npm --prefix production test`. The suite covers cross-account access, role changes, self-approval denial, and duplicate Gong requests. If you report a problem, include the role, test step, expected result, and what you observed.

### Try the MCP endpoint locally

While the demo is running, compare the Viewer’s tool list with the Gong operator’s. Use `endor-local-demo-jordan` to see the two outreach read tools. Both personas use the same account-level permissions as the console.

```sh
curl http://127.0.0.1:8080/mcp \
  -H 'Authorization: Bearer endor-local-demo-riley' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Use the operator’s token to read saved assignments.

```sh
curl http://127.0.0.1:8080/mcp \
  -H 'Authorization: Bearer endor-local-demo-jordan' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_outreach_drafts","arguments":{"account":"Copperline CRM Sandbox"}}}'
```

The token belongs to the local fixture. Use the OAuth setup in the deployment guide to connect Claude or ChatGPT to a hosted endpoint.

## Share on GitHub

Clone the repository or download its source ZIP from GitHub. Run the instructions above from the folder containing this README. The GitHub Actions workflow runs the same test suite on pushes and pull requests.

## Deploy to a workplace sandbox

Follow [the deployment guide](production/README.md) for PostgreSQL, Okta, Salesforce synchronization, account roles, and remote MCP. Its **Live Gong acceptance test** covers one approved contact and a one-step manual flow. Inspect the exact approved subject and body in Gong before using a live task.

## Explore the original demo

| Path | Use |
|---|---|
| `visual/Endor_CS_Knowledge_Graph.html` | Open the standalone graph of accounts, buying groups, evidence, actions, and proposed outreach. |
| `docs/Endor_CS_Business_Ontology.md` | Read definitions, evidence rules, and dataset relationships. |
| `data/canonical.sqlite3` and `data/csv/` | Inspect the fictional SQLite data and table and view exports. |
| `src/server.mjs` | Connect the original local demo to Claude Desktop using `claude_desktop_config.example.json`. |

The original demo uses local SQLite and simulated provider inputs. Use `node src/server.mjs` for stdio or add `--http` for a loopback HTTP MCP endpoint. It opens read-only by default. Add `--write --db <writable-sqlite-file>` to record changes in a copy, and set `ENDOR_CS_MCP_TOKEN` if using writable HTTP. [Claude Desktop local MCP setup](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)

### Simulate a Gong handoff in Claude Desktop

The local MCP demo can save and approve a fictional outreach draft and then POST a webhook to a Gong simulator on the same machine. The demo uses a copy at `data/gong-demo.sqlite3` so drafts and receipts survive a Claude restart. Use Node.js 24 or newer. The demo launches with Node alone and uses fictional data.

1. Unzip the complete demo so `src/server.mjs`, `docs/ontology.json`, and `data/canonical.sqlite3` are in the same project folder. On a Mac, enter the folder in Finder and confirm you can see `src`, `docs`, and `data`.
2. Quit Claude Desktop with **Command + Q**. In Terminal, run `open -a TextEdit "$HOME/Library/Application Support/Claude/claude_desktop_config.json"` to open the config file you already set up.
3. Under the `endor-digital-cs` entry, set `args` to the full path of the new `src/server.mjs` followed by `"--gong-demo"`. Keep the working `command` for Node. If you just want to verify that path before editing, run the command in Terminal with `--help` and check that the output includes `--gong-demo`.

   ```json
   "endor-digital-cs": {
     "command": "/usr/local/bin/node",
     "args": ["/absolute/path/to/Digital-Customer-Success-main-with-Gong/src/server.mjs", "--gong-demo"]
   }
   ```

4. Save and reopen Claude Desktop. In a new chat, use the first prompt to save a draft and review the exact text. If you edited an earlier preview, use `update_outreach_draft` with operation `edit` to save your final subject and body before approval.

   > Use `endor-digital-cs` to save a new direct follow-up draft for Jo Mercer at Copperline Cloud, Platform Engineering. Show me the saved draft ID, current revision, subject, and body. Pause for review.

5. When satisfied with the saved copy, use the second prompt. This approves the current copy and stops after queueing a simulated manual email task.

   > Approve the exact saved draft I just reviewed. Then use `simulate_gong_handoff` for that draft and its approved revision. The fictional Gong Engage Flow ID is `7100320000000000101`. Show me the stored webhook result, Gong assignment request body, request ID, and Flow instance ID. Stop at the manual task. Do not simulate sending the email.

The resulting draft status should be `queued`. `get_outreach_draft` shows the approved version, the HTTP 200 receipt, the fictional CRM lead ID `00Q000000000101EAA`, and the per-recipient Flow instance ID. A retry with the same draft ID and approved revision returns the recorded handoff. If the writable tools are missing, confirm Claude is using the new entry point with `--gong-demo` and restart the app.

The simulator receives `POST /webhooks/gong-engage`. Its receipt shows the documented routing fields for Gong’s `POST /v2/flows/prospects/assign` and the modeled result. The simulator stores the exact approved subject and HTML body in its own manual-step fields. Gong documents content overrides. Confirm the current field mapping with Gong and inspect the approved copy on a sandbox manual email task before a live rollout. Jo’s lead ID is a fixture. A live assignment needs a CRM contact or lead that Gong can resolve and a licensed owner with access to the Flow. [Gong assignment API](https://help.gong.io/apidocs/assign-prospects-contacts-or-leads-to-an-engage-flow-v2flowsprospectsassign-1) · [Gong content overrides](https://help.gong.io/docs/gong-engage-api-capabilities#overriding-flow-content-for-added-people)

Run `python3 data/build_database.py` and `node scripts/export-graph.mjs` to rebuild the original fixture and graph exports. The cloud pilot uses `production/schema.sql`.
