# Digital Customer Success production pilot

A Salesforce account and contact feed backs the browser console and remote MCP tools. Both surfaces use PostgreSQL and the same account grants. The console can save and approve an email draft and queue a manual Gong task for one configured pilot contact. MCP can read the draft and assignment status.

## What this pilot proves

The scheduled Salesforce job reads the accounts listed in `PILOT_ACCOUNT_IDS` and all visible contacts under them. It checks that every page arrives before applying a per-account database transaction. Changed names and contact titles generate timeline events. The account view and MCP queries pull current rows, including the last successful sync time. The browser also refreshes every 30 seconds while visible.

The deployment reads Salesforce account and contact changes and hands approved copy to a manual Gong task. Saving, approving, and queueing are separate console actions. The approval freezes the exact subject and body. A successful handoff records the Gong flow instance ID. The email remains a manual task for the configured owner.

| PostgreSQL record | Purpose |
|---|---|
| `cs_pilot.account` | One scoped Salesforce account with its current name and most recent successful sync |
| `cs_pilot.contact` | One current Salesforce contact under an account, with name, role and source timestamp |
| `cs_pilot.engagement_event` | One observed account or contact change with a stable event ID and both source and recording dates |
| `cs_pilot.account_access` | One grant linking an Okta user ID to an account |
| `cs_pilot.outreach_draft` | One account-scoped message with its saved revision and approval timestamp |
| `cs_pilot.gong_handoff` | One assignment attempt tied to an approved revision, with status and Gong IDs |

## Deploy to a sandbox

| Component | Configure |
|---|---|
| HTTPS service | One stable company-approved URL for the console and `/mcp` |
| PostgreSQL | A managed database and TLS connection strings from your cloud provider |
| Okta web app | OIDC web client with authorization code and PKCE and the exact `/oidc/callback` redirect URI |
| MCP OAuth | A connector-compatible authorization server that issues RS256 access tokens for the exact `https://<app-host>/mcp` audience, with `cs.read` and a stable user ID claim |
| Salesforce | Sandbox My Domain URL and a client-credentials integration user with permission to read the pilot Account and Contact fields |

Use `.env.example` for variable names. Set the actual values in the deployment environment or its secret manager. `MCP_USER_ID_CLAIM` defaults to `uid`. It must contain the same stable Okta user ID as the web ID token's `sub`. If a separate OAuth server issues the MCP token, configure that claim explicitly. Confirm the OAuth setup with the workplace identity administrator and the two target connector clients. [Okta authorization servers](https://developer.okta.com/docs/concepts/auth-servers/) · [OpenAI MCP authentication](https://developers.openai.com/plugins/build/auth) · [Claude remote connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)

Build the image from the unzipped kit root.

```sh
docker build -f production/Dockerfile -t endor-cs-pilot .
```

Run the migration with a database owner or migration role. Run the Salesforce pull with the configured sandbox integration and confirm that the job reports a visible account. Then grant the pilot user access to that account. These commands run inside the image with the applicable environment variables set, or locally from the kit root after `npm --prefix production ci`.

```sh
npm --prefix production run migrate
npm --prefix production run sync:salesforce
npm --prefix production run grant:account -- "<okta-user-id>" "<salesforce-account-id>"
```

Deploy the same image as the HTTPS web service. The default command runs `node production/server.mjs` on port 8080. Use `GET /health` for the platform readiness check. Set up a scheduled job with `node production/salesforce-sync.mjs` as its command. A five-minute interval is a starting point for a small account allowlist. The sync job gets a Salesforce access token per run. Set the interval with the CRM owner to fit the team's freshness target and API budget. [Salesforce integration user and client credentials](https://developer.salesforce.com/blogs/2024/02/invoke-rest-apis-with-the-salesforce-integration-user-and-oauth-client-credentials)

Use separate database credentials for deployment, the sync job, and the web service. The web service needs schema usage, read access to account, contact, engagement event and account grant tables, and read and write access to the two session tables, `outreach_draft` and `gong_handoff`. The sync job needs schema usage and read and write access to account, contact and engagement event tables. The migration role creates the schema and provisions grants. Point `MIGRATION_DATABASE_URL` and `INGEST_DATABASE_URL` to the corresponding roles. The web service uses `DATABASE_URL`.

### Connect the two surfaces

1. Open the console at `PUBLIC_URL` and sign in with the granted Okta test user.
2. Register `PUBLIC_URL/mcp` once in each approved workspace. Configure its OAuth client and redirect URI in the authorization server according to that client's instructions. The MCP endpoint publishes its protected-resource metadata at `/.well-known/oauth-protected-resource/mcp`.
3. Enable the connector and authenticate as the same test user. Ask it to list Salesforce accounts and open the test account timeline. Claude's remote connection originates from Anthropic's infrastructure and requires a reachable HTTPS endpoint. Keep the database connection private. [Claude remote connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) · [ChatGPT custom MCP](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)

## Acceptance test

Change the job title of a contact on the approved sandbox account. Run the scheduled job or trigger one run. Refresh the console and ask the connector for the latest timeline. The new title should appear in the contact graph, and both surfaces should return the same change event ID and source timestamp. An account-restricted test user should see only their own assigned records. The sync is rerunnable and an unchanged pull preserves event history.

Run the automated version with `npm --prefix production test` after installing the dependencies. It uses a local PostgreSQL engine, API fixtures, a test login provider, and signed OAuth test tokens. It checks freshness, authorization, and duplicate prevention for the Salesforce sync and Gong handoff.

## Live Gong acceptance test

The shareable demo uses a simulator. For a live test, use a dedicated Gong Engage flow with **one manual email step**, assign it to an Engage user, and use one approved test contact whose CRM ID is synced into that Gong workspace. Verify the step in Gong before enabling the integration and after any flow edit. Gong's flow-list API exposes flow metadata. Step configuration is verified in the workspace. [Manual email steps](https://help.gong.io/docs/understanding-flow-step-types) · [Flow list API](https://help.gong.io/apidocs/list-gong-engage-flows-v2flows-1)

1. Set the `GONG_` values from `.env.example` in the deployed service. The pilot pins the Okta operator, Salesforce account, CRM contact, flow, and task owner. Use the workspace API URL and a Gong API key authorized for flow assignment. Set `GONG_MANUAL_FLOW_CONFIRMED=true` after reviewing the flow. [Gong API authentication](https://help.gong.io/apidocs/) · [Flow assignment API](https://help.gong.io/apidocs/assign-prospects-contacts-or-leads-to-an-engage-flow-v2flowsprospectsassign-1)
2. Confirm the tenant's JSON request fields for a step content override with Gong. Gong documents overriding step subject and HTML body but its public assignment schema does not list those wire fields. Put the confirmed content-only fragment in `GONG_COPY_OVERRIDE_JSON` and use the exact string values `$approved_subject` and `$approved_body_html` for the two copy fields. Target the first manual email step. The adapter supplies the contact ID, flow ID, and owner separately. The fixture used by the automated test is a test contract. [Gong content override capability](https://help.gong.io/docs/gong-engage-api-capabilities#overriding-flow-content-for-added-people)
3. Set `GONG_MODE=live`, deploy, and sign in as the configured test operator. Select the approved contact, save a draft, approve the saved copy, and click **Queue manual Gong task**.
4. Open the assignee's manual task in Gong. Check the returned flow instance ID and compare the visible subject and body with the approved draft. The acceptance test ends with the task ready for review. The console also exposes the handoff through `list_outreach_drafts` and `get_outreach_draft`.

An assignment can be reported as rejected or pending review. For a timeout or an ambiguous response, inspect Gong using the test contact and flow before changing the configuration or trying another assignment. The pilot reserves the handoff before calling Gong and preserves uncertainty to prevent a duplicate task. A task assignment, an actual send, and a reply are separate events. This pilot records the assignment.
