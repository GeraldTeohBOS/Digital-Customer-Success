import { randomUUID } from "node:crypto";

const validId = id => typeof id === "string" && /^(?:[A-Za-z0-9]{15}|[A-Za-z0-9]{18})$/.test(id);
const validDate = date => typeof date === "string" && /^\d{4}-\d{2}-\d{2}T/.test(date) && Number.isFinite(Date.parse(date));
const validName = name => typeof name === "string" && name.trim().length > 0 && name.length <= 255;
const asTime = value => new Date(value).getTime();

export function checkAccountIds(ids) {
  if (!Array.isArray(ids) || !ids.length || !ids.every(validId)) {
    throw new Error("Supply one or more valid Salesforce account IDs.");
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
  function canonical(id) {
    let suffix = "";
    let prefix = "";
    for (let start=0;start<15;start+=5) {
      const block = id.slice(start,start+5);
      const bits = id.length === 18 ? alphabet.indexOf(id[15+start/5].toUpperCase()) :
        [...block].reduce((value,character,index) => value + (/[A-Z]/.test(character) ? (1 << index) : 0),0);
      if (bits < 0) throw new Error("Invalid Salesforce account ID suffix.");
      suffix += alphabet[bits];
      prefix += [...block].map((character,index) => bits & (1 << index) ? character.toUpperCase() : character.toLowerCase()).join("");
    }
    return prefix + suffix;
  }
  return [...new Set(ids.map(canonical))];
}

function validateSnapshot({accountId, account, contacts, startedAt}) {
  if (!validId(accountId) || !validDate(startedAt) || !Array.isArray(contacts)) {
    throw new Error("Invalid Salesforce snapshot scope or sync time.");
  }
  if (account === null ? contacts.length > 0 :
      account.Id !== accountId || !validName(account.Name) || !validDate(account.SystemModstamp)) {
    throw new Error("The Salesforce account snapshot is incomplete or out of scope.");
  }
  for (const row of contacts) {
    if (!validId(row.Id) || row.AccountId !== accountId || !validName(row.Name) ||
        !validDate(row.SystemModstamp) || (row.Title != null && typeof row.Title !== "string")) {
      throw new Error("An incomplete or out-of-scope Salesforce contact was returned.");
    }
  }
  if (new Set(contacts.map(row => row.Id)).size !== contacts.length) throw new Error("Duplicate contact IDs in a Salesforce snapshot.");
}

export async function applySnapshot(pool, snapshot) {
  validateSnapshot(snapshot);
  const {accountId, account, contacts, startedAt} = snapshot;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // A scope lock serializes the first insert as well as later snapshot replacements.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[accountId]);
    const {rows:[current]} = await client.query("SELECT * FROM cs_pilot.account WHERE account_id = $1",[accountId]);
    if (current && asTime(current.synced_at) >= asTime(startedAt)) {
      await client.query("COMMIT");
      return {account_id:accountId,changed:0,skipped:"older_sync"};
    }
    if (!account) {
      if (current) {
        await client.query("UPDATE cs_pilot.account SET active = false, synced_at = $2 WHERE account_id = $1",[accountId,startedAt]);
        await client.query("DELETE FROM cs_pilot.contact WHERE account_id = $1",[accountId]);
      }
      await client.query("COMMIT");
      return {account_id:accountId,changed:0,source_visible:false};
    }
    if (current && asTime(current.source_modified_at) > asTime(account.SystemModstamp)) {
      throw new Error("Salesforce returned a version older than the current account record.");
    }
    await client.query(`INSERT INTO cs_pilot.account (account_id,account_name,source_modified_at,synced_at,active)
      VALUES ($1,$2,$3,$4,true) ON CONFLICT (account_id) DO UPDATE
      SET account_name=excluded.account_name,source_modified_at=excluded.source_modified_at,synced_at=excluded.synced_at,active=true`,
    [accountId,account.Name,account.SystemModstamp,startedAt]);
    let changed = 0;
    async function record(kind, personId, title, summary, occurredAt) {
      await client.query(`INSERT INTO cs_pilot.engagement_event
        (event_id,account_id,person_id,event_kind,title,summary,occurred_at,recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [randomUUID(),accountId,personId,kind,title,summary,occurredAt,startedAt]);
      changed++;
    }
    if (!current?.active || current.account_name !== account.Name) {
      await record("account_updated",null,account.Name,current?.active ? "Salesforce account name updated." : "Salesforce account imported.",account.SystemModstamp);
    }
    const {rows} = await client.query("SELECT * FROM cs_pilot.contact WHERE account_id = $1",[accountId]);
    const prior = new Map(rows.map(row => [row.person_id,row]));
    for (const row of contacts) {
      const previous = prior.get(row.Id);
      prior.delete(row.Id);
      const title = row.Title?.trim() || null;
      if (previous && asTime(previous.source_modified_at) > asTime(row.SystemModstamp)) {
        throw new Error("Salesforce returned a version older than the current contact record.");
      }
      if (previous?.full_name !== row.Name || previous?.job_title !== title ||
          asTime(previous?.source_modified_at) !== asTime(row.SystemModstamp)) {
        await client.query(`INSERT INTO cs_pilot.contact (account_id,person_id,full_name,job_title,source_modified_at)
          VALUES ($1,$2,$3,$4,$5) ON CONFLICT (account_id,person_id) DO UPDATE
          SET full_name=excluded.full_name,job_title=excluded.job_title,source_modified_at=excluded.source_modified_at`,
        [accountId,row.Id,row.Name,title,row.SystemModstamp]);
        if (previous?.full_name !== row.Name || previous?.job_title !== title) {
          await record(previous ? "contact_updated" : "contact_added",row.Id,row.Name,
            title ? "Salesforce contact title is " + title + "." : "Salesforce contact has no title.",row.SystemModstamp);
        }
      }
    }
    for (const [id] of prior) {
      await client.query("DELETE FROM cs_pilot.contact WHERE account_id = $1 AND person_id = $2",[accountId,id]);
      await record("contact_removed",id,"Contact removed from scope","The contact is no longer visible under this Salesforce account.",startedAt);
    }
    await client.query("COMMIT");
    return {account_id:accountId,changed,source_visible:true};
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
