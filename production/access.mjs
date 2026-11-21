import {RequestError} from "../src/service.mjs";
import {checkAccountIds} from "./ingest.mjs";
import {PermissionError,permitted,roles} from "./permissions.mjs";

const unavailable = () => new PermissionError("Access administration is unavailable for this account.");
const canManage = permitted("a.account_id","$1","access.manage");
const managedRoles = Object.entries(roles).filter(([key]) => key !== "access_admin")
  .map(([id,{label}]) => ({id,label}));

function canonicalAccount(input) {
  try { return checkAccountIds([input])[0]; }
  catch { throw new RequestError("Use a valid Salesforce account ID."); }
}

function changeInput(input) {
  const {operation,account_id,user_id,role} = input ?? {};
  if (!["grant","revoke"].includes(operation) || typeof role !== "string" || !Object.hasOwn(roles,role) ||
      typeof user_id !== "string" || user_id.length > 300 || !user_id.trim() || /[\u0000-\u001f]/.test(user_id)) {
    throw new RequestError("Select a role and specify the target user's verified identity ID.");
  }
  return {operation,accountId:canonicalAccount(account_id),userId:user_id.trim(),role};
}

export async function changeAccountRole(pool,actor,input,{bootstrap = false} = {}) {
  const {operation,accountId,userId,role} = changeInput(input);
  if (!bootstrap && (userId === actor || role === "access_admin")) {
    throw new PermissionError("An access admin may manage other users' non-admin roles.");
  }
  const accountScope = bootstrap ? "true" : canManage;
  const write = operation === "grant" ?
    `INSERT INTO cs_pilot.account_role_grant (account_id,user_id,role,granted_by)
      SELECT account_id,$3,$4,$1 FROM authorized ON CONFLICT DO NOTHING RETURNING account_id` :
    `DELETE FROM cs_pilot.account_role_grant g USING authorized
      WHERE g.account_id=authorized.account_id AND g.user_id=$3 AND g.role=$4 RETURNING g.account_id`;
  const {rows:[outcome]} = await pool.query(`WITH authorized AS (
      SELECT a.account_id FROM cs_pilot.account a WHERE a.account_id=$2 AND (a.active OR $5='role.revoke') AND ${accountScope}
    ), changed AS (${write}), recorded AS (
      INSERT INTO cs_pilot.authorization_audit (account_id,actor_id,action,target_user_id,target_role)
      SELECT account_id,$1,$5,$3,$4 FROM changed RETURNING audit_id
    )
    SELECT EXISTS (SELECT 1 FROM authorized) AS allowed, EXISTS (SELECT 1 FROM recorded) AS changed`,
  [actor,accountId,userId,role,"role." + operation]);
  if (!outcome.allowed) throw unavailable();
  return {changed:outcome.changed};
}

export function createAccessService(pool,userId) {
  return {
    async listManagedAccounts() {
      const {rows:accounts} = await pool.query(`SELECT a.account_id FROM cs_pilot.account a
        WHERE a.active AND ${canManage} ORDER BY a.account_id`,[userId]);
      return {accounts,roles:managedRoles};
    },
    async getAccountAccess(input) {
      const accountId = canonicalAccount(input);
      const {rows:[row]} = await pool.query(`SELECT a.account_id,
        (SELECT COALESCE(jsonb_agg(g ORDER BY g.user_id,g.role),'[]') FROM (
          SELECT user_id,role,granted_at FROM cs_pilot.account_role_grant WHERE account_id=a.account_id
        ) g) AS grants,
        (SELECT COALESCE(jsonb_agg(e ORDER BY e.recorded_at DESC,e.audit_id DESC),'[]') FROM (
          SELECT audit_id,actor_id,action,target_user_id,target_role,draft_id,revision,recorded_at
          FROM cs_pilot.authorization_audit WHERE account_id=a.account_id ORDER BY recorded_at DESC,audit_id DESC LIMIT 25
        ) e) AS audit
        FROM cs_pilot.account a WHERE a.active AND a.account_id=$2 AND ${canManage}`,[userId,accountId]);
      if (!row) throw unavailable();
      return row;
    },
    changeAccountRole(input) { return changeAccountRole(pool,userId,input); },
  };
}
