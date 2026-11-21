# Digital Customer Success business ontology

The ontology gives a CSM and the connector a shared vocabulary for who bought, what was deployed, what changed, whose evidence supports a decision, and which group should be engaged next. It describes a fictional Endor Labs workspace.

## Identity and ownership

| Entity | Grain and stable key | Operating meaning |
|---|---|---|
| Account | One customer organization, alphanumeric `account_id` | Stable portfolio key. `account_name` preserves the CRM display name. |
| Account alias | One historical connector alias, `legacy_account_id` | Translates earlier fixture references to the canonical ID. |
| Buying group | One decision-making group within the account, `buying_group_id` | The team, objective, and buying decision that the conversation belongs to |
| Person and membership | One person, `person_id`, with a separate membership per group | A champion, evaluator, or economic buyer is a role within a group |
| Contract | One product agreement, `contract_id` | Renewal date, licensed unit and purchased seat count scoped to the incumbent group |
| Deployment | One rollout under an agreement, `deployment_id` | The scope used for adoption and value measurement |
| Product use case | One product capability applied to one buying group’s problem, `use_case_id` | Names the commercial product, deployment or proposed pilot, workflow, adoption definition and success measure |
| Adoption snapshot | One deployment, date, and measurement window, `snapshot_key` | Counts, denominator, scope version, target, and source |
| Contributor usage | One contract, date, and lookback window, `seat_usage_key` | The count of contributing developers in the monitored scope |
| Health assessment | One account and assessment date, `account_id` plus `assessed_on` | CSM-assessed health, churn risk, rationale, and source |
| Value measurement | One baseline or observed metric with a supporting event, `measurement_id` | Measured performance within the named rollout and reporting scope |
| Event | One dated source record, `event_id` | A CRM note, email thread, product observation, market signal, support case, or marketing interaction |
| Observation | One scoped statement or measurement, `observation_id` | Links original text or a specific email message to an observed fact, buying group, Endor capability and evidence role |
| Qualification signal | One sourced observation, `signal_id` | A structured blocker, direct discovery request, evaluation path, or market context |
| Work case | One stalled deployment or one interested buying group, `case_id` | A rule-derived candidate with evidence to examine in chat |
| Workstream | One account and buying-group objective for a customer-success job, `workstream_id` | Ties source evidence and a case when available to accountable work |
| Owned action | One task with a due date, `action_id` | A warehouse record with an accountable staff owner, optional customer contact and current status |
| Action update | One appended revision, `action_id` plus `revision` | A progress or outcome note with a recorded time, optional source evidence and optional successor action |
| Outreach draft | One generated message, `draft_id` | The selected stakeholder, actual recipient, assigned sender, related expansion workstream, source IDs, and generated subject and body |
| Outreach revision | One recorded transition, `draft_id` plus `revision` | Records edits, approval, the simulated handoff, and simulated email activity with the exact copy at each step |

Account-scoped joins keep customer contacts, groups, and signals within their customer account. An event may concern multiple groups and people. An email message belongs to an event thread and has a sender and per-message recipients. A source namespace plus source-record reference identifies the event for deduplication. The database enforces keys and referential constraints. A missing economic buyer remains unknown.

## Endor Labs product grounding

Endor Labs describes application security across first-party code, dependencies, and container images. The demo uses Endor Open Source for reachability-based software composition analysis (SCA) and container image scanning, and Endor Code for AI SAST on first-party code. These are public product categories. The accounts, assets, messages, telemetry, and outcomes are fictional. [Endor Labs platform](https://www.endorlabs.com/platform) · [Product lines](https://www.endorlabs.com/pricing)

| Scoped use case | Product and capability | Customer problem and measure |
|---|---|---|
| BrackenPay Payments | Endor Open Source · Reachability-based SCA | Prioritize dependency fixes. Track dependency scan coverage and scoped remediation time. |
| AsterVale Clinical | Endor Open Source · Reachability-based SCA | Triage dependency findings within the customer’s SLA. Track repository coverage and the share resolved within SLA. |
| Copperline Product Security | Endor Open Source · Reachability-based SCA | Shorten remediation time on dependency findings in the contracted repository scope. |
| Copperline Platform Engineering | Endor Open Source · Reachability-based SCA in shared CI | Standardize dependency checks. Validate scans and usable reachability results on two templates and compare setup minutes per team. |
| Stratos Storefront | Endor Open Source · Container image scanning and reachability | Prioritize findings in Storefront service images. Track image scan coverage at repository grain and measured triage hours. |
| Stratos Fulfillment | Endor Open Source · Container image scanning and reachability | Evaluate image scanning on images built from three Fulfillment repositories. Agree on a separate triage baseline. |
| Ironvale Routing | Endor Code · AI SAST | Route actionable first-party code findings to owners. Verify first scans across five new repositories and monitor time to remediate. |

## How the system identifies evidence, observations, and workstreams

| Record | How it is identified in the demo |
|---|---|
| Evidence event | The fixture supplies the source, date, original text and linked account and people. The warehouse keeps a stable `event_id` for that source record. A case or workstream cites it as `evidence_event_id` when it supports that decision. Each email message has its own `message_id`. |
| Observation | A demo author records the scoped fact and its role in `cs_event_observation` and points to the event summary, body or exact email message. `v_event_observations` joins the original words with the observation, product and buying group. Numeric observations such as repository coverage come from the underlying telemetry and SQL. |
| Rule result | The Knowledge layer uses `qualification_signal` and adoption snapshots to decide if a case qualifies. A direct request from a prospective buying-group member can open expansion discovery. Market signals, marketing engagement and incumbent results supply context. |
| Workstream | A seeded `cs_workstream` records the CSM’s ongoing objective for one account and buying group. It links to a product use case, a supporting event and, where eligible, a rule-derived `case_id`. Actions such as confirming a pilot baseline belong to that objective. |

The current prototype reads curated fixture observations and uses SQL for eligibility. Claude and ChatGPT retrieve the warehouse records through MCP and can explain the recommendation. The scoped source and observation IDs remain visible in their tool results.

For Copperline, `cc-email` is the original thread. `cc-email:message-1` offers Product Security’s deployment as a reference. `cc-email:message-2` records Drew’s request to evaluate two shared templates. It grounds `cc-email:observation-2` and the `cc-email:discovery_request` signal. The rule produces `copperline:platform-engineering/expansion`, linked to the `copperline:expansion` workstream and its owned action.

## Decision rules

- **Adoption** measures successful scans in the rolling 30-day window divided by repositories in the agreed deployment scope. A stall requires a gap of at least 10 percentage points and improvement of 3 points or less against a comparable baseline 28 to 35 days earlier. The quality state directs missing, stale, or noncomparable data to verification.
- **Expansion** requires a recent explicit first-party discovery request from a member of the prospective group. A market signal can add context to the discovery. Qualification in this demo means discovery requested.
- **Account health and churn risk** are dated CSM assessments. Value measurements retain their deployment, unit, baseline or observed period, and source.
- **Licensed seats** come from the active contract. **Seat utilization** divides 90-day contributing developers by purchased seats for contributor-priced contracts. Endor Labs defines contributor seats for Endor Code and Endor Open Source using commits to monitored repositories over the preceding 90 days. The license counts and contributor counts in this dataset are fictional. [Endor Labs pricing](https://www.endorlabs.com/pricing)
- **Portfolio repository adoption** reports the latest fresh 30-day coverage for an account with one active deployment. The portfolio shows total known contributor entitlements across active contracts and reports utilization at contract level when scopes may overlap.
- **Snapshot time and rule version** are published with queue results. The MCP tools return internal evidence and recommendations for this fictional workspace.

## Copperline Cloud example

Product Security owns the existing agreement. Nadia Park is Product Security’s economic buyer. The incumbent deployment has scanned 92 of 100 repositories in scope. Its median remediation time moved from 10 to 6 days within the measured scope.

Copperline Cloud's canonical account ID is `AC0003`. Its fictional existing agreement covers 200 licensed seats and records 166 contributing developers over 90 days, for 83% utilization. The 92% repository adoption rate uses the deployment's repository scope and a 30-day window.

Platform Engineering is a prospective buying group with its own objective and funding decision. Drew Ito requested discovery after Lina Morales introduced him. Rina Sen is the target economic buyer, and her meeting note asks for a separate setup-time baseline on two shared CI templates. The direct request is the qualifying evidence. Product Security’s results can inform the introduction. The prospective pilot will have its own measurement.

Morgan Rivera owns `copperline:expansion/initial`. The discovery step is to agree on the setup-time baseline and decision criteria with Drew. The CSM checks contract coverage with the account team, then hands off to Sales once Drew agrees to the pilot and Rina confirms the funding path and decision date. Both funding and the decision date remain unconfirmed in the snapshot.

## Expansion buying-group research

The research starts with an account, a prospective buying group, an organization scope and an Endor use case. The two scopes are Copperline’s Platform Engineering business unit and Stratos Fulfillment Services LLC, a fictional subsidiary. Its proposed pilot and budget are scoped to Fulfillment. The existing Stratos agreement covers the Storefront deployment in the demo records, and affiliate eligibility is a commercial question for the account team.

| Source or step | What it contributes |
|---|---|
| Simulated Sumble | Dated jobs, technologies, projects and organizational relationships. Each signal retains an excerpt, source reference and a hypothesis about why it matters. [Sumble data documentation](https://docs.sumble.com/our-data) |
| Simulated Clay | Named people matching the target company and role. Each profile carries a title, reported team, possible buying role, simulated work email status and the Sumble signal that explains the role search. [Clay Find People](https://university.clay.com/lessons/find-people-clay-101) · [Work Email waterfall](https://university.clay.com/docs/work-email-waterfall) |
| Identity matching | Compare the exact normalized work email within the account. Check the target group, entity domain and 45-day freshness. Deduplicate CRM matches. A conflicting team, duplicate identity, missing email or out-of-date record goes to review. |
| Historical engagement agent | Resolves identity, retrieves the actual content agenda and engagement, then compares it with recent scoped colleague observations and simulated company evidence. Returns competing hypotheses, evidence for each, why these resources, why now, the relevant Endor value, and what to validate in a 1:1. |
| Outreach draft | Uses the stakeholder’s point of view to ask a specific validation question and propose a CSM conversation. An attributed, relevant question and current discovery can support a direct 1:1. Passive or unresolved engagement can support a warm path through the known evaluator. |

Copperline adds Jo Mercer, a likely implementation owner, and Alma Voss, a possible security reviewer. Drew remains the known evaluator after an exact CRM match. Jo’s webinar question is attributed through the separate marketing identity `lead-cc-jo`, which links to `cc-jo-webinar`. Stratos adds Nia Okafor as a technical evaluator and Selene Park as a potential sponsor. Nia’s registration and download inform the topic for an introduction through Felix. The subsidiary’s economic buyer is still unknown.

Sumble and Clay are represented by seeded research rows. The historical engagement agent and outreach templates run against the canonical database through MCP. Buyer roles remain hypotheses until a first-party source confirms authority. Candidate research and drafts live alongside the existing workstream and discovery case.

### From Jo’s engagement to a 1:1

The webinar covered shared dependency checks and reachability results. Jo’s question exposed a specific implementation concern about one workflow for Java and Go with findings available to each team. Jo later downloaded a checklist about ownership and rollout. The agent treats a shared check with repo-level ownership as the leading hypothesis, reducing setup effort as a plausible second motive, and technical learning as an alternative.

Drew’s two-template discovery request and Rina’s evaluation criteria create a window to ask Jo how findings should reach repo owners before the pilot design is fixed. Simulated company research corroborates the CI standardization context. A 20-minute CSM 1:1 can validate the workflow and end with a proposed test for successful scans, setup minutes and usable reachability results. A subsequent group conversation can include Drew if Jo confirms the problem. [Endor Labs platform](https://www.endorlabs.com/platform)

The synthesis runs from evidence rules for the two fictional expansion use cases. It retains original records and source IDs alongside the proposed interpretation. A registered webinar, attendance, a download and a directly attributed question carry different weight. The underlying case and buying authority continue to follow first-party evidence.

## Outreach review and delivery

The console and writable MCP connector share one workflow per saved draft. The Knowledge layer generates the subject and body from the evidence and persists the draft with its target group, workstream, actual recipient, sender, and source event IDs. For a direct email to Jo, the stakeholder and recipient are both Jo. A warm introduction for Nia can address Felix while retaining Nia as the stakeholder.

| CSM action | Warehouse record | What appears in the console |
|---|---|---|
| Generate and save | `cs_outreach_draft` saves the original copy and evidence | Editable subject and body, sender, recipient, and evidence |
| Approve copy | `cs_outreach_revision` captures the exact approved subject and body | Approved state and review history |
| Queue in Gong | A revision stores the simulated flow assignment and manual email step override | Queued state, simulated CRM ID, and flow instance ID |
| Simulate send or log a simulated reply | A revision stores the sent copy or reply text, with an event in `v_outreach_timeline` | Clickable activity in the account timeline |

Editing an approved draft reopens review before it can be queued. The server rejects stale revisions and reuses the recorded result when an identical transition is retried. Gong queueing and sending are simulated. Simulated email events remain separate from the source snapshot used for qualification and first-party engagement.

## Canonical datasets

The downloadable SQLite database implements the ontology. `ontology.json` lists each table and view with its key, grain, authority, and sort order. The CSV exports mirror these schemas. Contact roles and source-event relationships live in junction tables.

| View | Answers |
|---|---|
| `v_account_portfolio` | What are the account ID, name, health, churn risk, entitlements, and scoped adoption and utilization? |
| `v_contract_seat_metrics` | What was purchased and how many developers contributed in the contract scope? |
| `v_buying_group_members` | Who belongs to the group, and who owns its buying decision? |
| `v_engagement_timeline` | What happened, in what source, and when? |
| `v_product_use_cases` | Which Endor product and capability address the buying group’s problem, and how is success measured? |
| `v_event_observations` | What fact was recorded, what were the original words, and what product use case or decision does it support? |
| `v_expansion_targets` | Which entity and buying group are being researched, and what does the first-party discovery record establish? |
| `sumble_org_signal` | What hiring, stack, initiative or ownership evidence suggests a reason to explore this group? |
| `v_clay_candidate_match` | Which enriched people match the group, which are already in CRM, and which should be reviewed? |
| `v_expansion_first_party_history` | Which CRM or marketing identity is linked to each dated touch, and did the person author or take part in it? |
| `v_adoption_history` | What changed in the agreed deployment scope over time? |
| `v_deployment_health` | Is the latest measurement comparable, and which adoption rule applies? |
| `v_expansion_discovery` | What qualifying request did the prospective group make? |
| `v_work_queue` | Which deployment or buying group merits CSM attention, and what is the evidence? |
| `v_customer_action_queue` | Who owns the next step, when is it due, and what was recorded? |
| `v_customer_action_history` | Which status, due date and outcome changes have been recorded, and which follow-up was created? |
| `v_outreach_draft_queue` | What is the current copy, who owns it, and which approval or delivery step is next? |
| `v_outreach_timeline` | What was actually logged in the simulation and which exact draft revision produced it? |

The standalone HTML shows the published source and action snapshot with proposed email previews. The hosted console and hosted MCP connector share live outreach drafts and revisions in the warehouse. The local MCP connector can use a separate writable SQLite copy. The warehouse stores raw action updates in `cs_action_update`, with timestamps and the original intent for retry detection.

## Customer Success jobs and the workflow they share

The first build is the owned action record. An observation can suggest several responses, but the CSM needs to know who will take the next step and when to check it. A written outcome lets the next CSM pick up the same work without rereading the whole thread. BrackenPay’s `brackenpay:rollout/initial` action assigns Morgan Rivera to confirm the November 24 GitHub App approval with Theo Marshall. If the approval is confirmed, Morgan can record the outcome and set a dated checkpoint for the next ten repositories in one operation.

| Job | Example action and context | Canonical records |
|---|---|---|
| Get to first value | Verify the first successful AI SAST scans on Ironvale’s five new Routing repositories. The outcome requires scan evidence for that batch. | `cs_milestone`, `adoption_snapshot` |
| Move the rollout forward | Confirm the first three owners for AsterVale’s stalled 15-repository batch. Review 52% current coverage against the 80% target. | `cs_milestone`, `v_deployment_health` |
| Prove value for renewal | Review BrackenPay’s measured 12-to-8-day median remediation change with Priya. The simulated notice date and annual contract value are context for the review. | `cs_renewal_review`, `value_measurement`, `subscription_contract` |
| Coordinate risk intervention | Review BrackenPay’s approval outcome on November 25. The internal escalation depends on the customer approval checkpoint on November 24. | `cs_risk_review`, `account_health_assessment` |
| Qualify expansion | Agree a separate baseline and decision path for Copperline’s Platform Engineering group. Stratos demonstrates discovery with an unknown economic buyer. | `cs_expansion_review`, `buying_group`, `group_membership`, `v_contract_seat_metrics` |

`list_customer_actions` prioritizes the active work by due date. `get_customer_action` opens the job context and the current revision. `record_customer_action` appends a CSM update and optionally creates one follow-up on completion. Retrying the same revision and update returns the first result. Achieved milestones, customer-acknowledged value, risk reassessments and funding decisions retain their own source evidence.
