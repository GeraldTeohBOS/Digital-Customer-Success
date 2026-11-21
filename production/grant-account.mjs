import pg from "pg";
import {required} from "./config.mjs";
import {checkAccountIds} from "./ingest.mjs";

const [userId,inputId] = process.argv.slice(2);
if (!userId?.trim() || userId.length > 300 || !inputId) throw new Error("Usage: npm run grant:account -- <Okta user ID> <Salesforce account ID>");
const [accountId] = checkAccountIds([inputId]);
const pool = new pg.Pool({connectionString:process.env.MIGRATION_DATABASE_URL || required(process.env,"DATABASE_URL")});
try {
  await pool.query("INSERT INTO cs_pilot.account_access (user_id,account_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",[userId,accountId]);
  console.log("Account access grant recorded.");
} finally {
  await pool.end();
}
