import {RequestError} from "../src/service.mjs";

const reference = description => ({type:"string",description,minLength:1,maxLength:160});
const schema = (properties,required) => ({type:"object",properties,required,additionalProperties:false});
const account = reference("Salesforce account ID or exact account name.");
export const pilotTools = {
  list_accounts:{description:"List active Salesforce accounts assigned to the signed-in user, with the latest sync time."},
  get_account:{description:"Get a permitted Salesforce account, its current contacts and source freshness."},
  list_timeline:{
    description:"List imported Salesforce account and contact changes newest first, with source and sync timestamps.",
    inputSchema:schema({account,person_id:reference("Optional Salesforce contact ID from get_account."),
      before_utc:reference("Optional exclusive ISO 8601 timestamp."),
      limit:{type:"integer",minimum:1,maximum:50,description:"Maximum timeline records."}},["account"]),
  },
  get_event:{description:"Open a Salesforce account or contact change from the activity timeline by event ID."},
  get_knowledge_graph:{
    description:"Get typed account-to-contact relationships from the latest Salesforce data available to the user.",
    inputSchema:schema({account,mode:{type:"string",enum:["relationships"],description:"Return account and contact relationships."}},["account"]),
  },
  list_outreach_drafts:{
    description:"List saved pilot drafts and manual Gong handoff status in a permitted account.",
    inputSchema:schema({account,person:reference("Optional Salesforce contact ID or exact contact name."),
      limit:{type:"integer",minimum:1,maximum:50,description:"Maximum drafts."}},["account"]),
  },
  get_outreach_draft:{description:"Open saved copy and any approved manual Gong assignment. A queued assignment is a pending email task."},
};

export function createPilotService(pool,userId) {
  const scope = `JOIN cs_pilot.account_access access USING(account_id) WHERE a.active AND access.user_id=$1`;
  const missing = () => new RequestError("This Salesforce account or event is unavailable to your signed-in user.");
  const iso = value => new Date(value).toISOString();
  const freshness = syncedAt => ({source:"Salesforce",synced_at:iso(syncedAt),queried_at:new Date().toISOString()});
  const portfolio = `SELECT a.account_id,a.account_name,a.source_modified_at,a.synced_at FROM cs_pilot.account a ${scope}`;

  async function resolve(referenceValue) {
    const {rows} = await pool.query(portfolio + ` AND (a.account_id=$2 OR lower(a.account_name)=lower($2))
      ORDER BY (a.account_id=$2) DESC LIMIT 2`,[userId,referenceValue.trim()]);
    if (!rows.length) throw missing();
    if (rows.length > 1 && rows[0].account_id !== referenceValue.trim()) {
      throw new RequestError("More than one assigned account has this name. Use its Salesforce account ID.");
    }
    return rows[0];
  }

  async function listAccounts() {
    const {rows:accounts} = await pool.query(portfolio + " ORDER BY a.account_name, a.account_id",[userId]);
    return {source:"Salesforce",queried_at:new Date().toISOString(),accounts};
  }

  async function getAccount({account:accountReference}) {
    const {account_id} = await resolve(accountReference);
    const {rows:[row]} = await pool.query(`SELECT a.account_id,a.account_name,a.source_modified_at,a.synced_at,
      (SELECT COALESCE(jsonb_agg(c ORDER BY c.full_name,c.person_id),'[]') FROM cs_pilot.contact c
       WHERE c.account_id=a.account_id) AS contacts FROM cs_pilot.account a ${scope} AND a.account_id=$2`,[userId,account_id]);
    if (!row) throw missing();
    const {contacts,...profile} = row;
    return {account:profile,contacts,freshness:freshness(profile.synced_at)};
  }

  async function listTimeline({account:accountReference,person_id=null,before_utc=null,limit=25}) {
    const {account_id} = await resolve(accountReference);
    if (before_utc && (!/^\d{4}-\d{2}-\d{2}T/.test(before_utc) || !Number.isFinite(Date.parse(before_utc)))) {
      throw new RequestError("Use an ISO 8601 timestamp for before_utc.");
    }
    const {rows:[row]} = await pool.query(`SELECT a.synced_at,
      (SELECT COALESCE(jsonb_agg(e ORDER BY e.occurred_at DESC,e.event_id),'[]') FROM (
        SELECT e.*,'Salesforce' AS source_name FROM cs_pilot.engagement_event e
        WHERE e.account_id=a.account_id AND ($3::text IS NULL OR e.person_id=$3)
          AND ($4::timestamptz IS NULL OR e.occurred_at < $4) ORDER BY e.occurred_at DESC,e.event_id LIMIT $5
      ) e) AS events FROM cs_pilot.account a ${scope} AND a.account_id=$2`,
    [userId,account_id,person_id,before_utc ? iso(before_utc) : null,limit]);
    if (!row) throw missing();
    return {account_id,events:row.events,freshness:freshness(row.synced_at)};
  }

  async function getEvent({event_id}) {
    const {rows:[event]} = await pool.query(`SELECT e.*, a.synced_at, 'Salesforce' AS source_name
      FROM cs_pilot.engagement_event e JOIN cs_pilot.account a USING(account_id) ${scope} AND e.event_id=$2`,[userId,event_id]);
    if (!event) throw missing();
    return {event,freshness:freshness(event.synced_at)};
  }

  async function getKnowledgeGraph(args) {
    const {account:profile,contacts,freshness:status} = await getAccount(args);
    const nodes = [{
      id:profile.account_id,type:"account",label:profile.account_name,subtitle:"Salesforce account",lane:0,
      fields:{"Account ID":profile.account_id,"Source modified":iso(profile.source_modified_at),"Last synced":status.synced_at},
    },...contacts.map(person => ({
      id:person.person_id,type:"person",label:person.full_name,subtitle:person.job_title || "Salesforce contact",lane:1,
      fields:{"Contact ID":person.person_id,"Job title":person.job_title || "Unspecified","Source modified":iso(person.source_modified_at)},
    }))];
    return {account_id:profile.account_id,mode:"relationships",freshness:status,nodes,
      edges:contacts.map(person => ({from:profile.account_id,to:person.person_id,relationship:"account_contact",label:"Contact"}))};
  }

  return {listAccounts,getAccount,listTimeline,getEvent,getKnowledgeGraph};
}
