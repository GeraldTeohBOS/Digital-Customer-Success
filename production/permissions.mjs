import {RequestError} from "../src/service.mjs";

export class PermissionError extends RequestError {}

export const roles = {
  viewer: {label:"Viewer", permissions:["account.read"]},
  csm: {label:"CSM", permissions:["account.read","outreach.read","outreach.draft"]},
  approver: {label:"Approver", permissions:["account.read","outreach.read","outreach.approve"]},
  gong_operator: {label:"Gong operator", permissions:["account.read","outreach.read","outreach.queue"]},
  access_admin: {label:"Access admin", permissions:["access.manage"]},
};

export function capabilities(assignedRoles) {
  return [...new Set(assignedRoles.flatMap(role => roles[role].permissions))];
}

// Only internal SQL identifiers and permissions from the role registry belong here.
export function permitted(accountColumn,userParameter,permission) {
  const matching = Object.entries(roles).filter(([,role]) => role.permissions.includes(permission)).map(([name]) => "'" + name + "'");
  if (!matching.length) throw new Error("Unknown pilot permission.");
  return `EXISTS (SELECT 1 FROM cs_pilot.account_role_grant AS rbac
    WHERE rbac.account_id=${accountColumn} AND rbac.user_id=${userParameter} AND rbac.role IN (${matching.join(",")}))`;
}

export async function activePermissions(pool,userId) {
  const {rows} = await pool.query(`SELECT DISTINCT g.role FROM cs_pilot.account_role_grant g
    JOIN cs_pilot.account a USING(account_id) WHERE g.user_id=$1 AND a.active`,[userId]);
  return capabilities(rows.map(row => row.role));
}
