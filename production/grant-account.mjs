import pg from "pg";
import {required} from "./config.mjs";
import {changeAccountRole} from "./access.mjs";

const [operation,user_id,account_id,role = "viewer"] = process.argv.slice(2);
if (!user_id || !account_id) throw new Error("Supply the Okta user ID, Salesforce account ID and optional role.");
const pool = new pg.Pool({connectionString:process.env.MIGRATION_DATABASE_URL || required(process.env,"DATABASE_URL")});
try {
  const {rows:[session]} = await pool.query("SELECT current_user AS actor");
  const result = await changeAccountRole(pool,"db:" + session.actor,{operation,user_id,account_id,role},{bootstrap:true});
  console.log(result.changed ? "Account role change recorded." : "No account role change was needed.");
} finally {
  await pool.end();
}
