import {readFile} from "node:fs/promises";
import pg from "pg";
import {required} from "./config.mjs";

const connectionString = process.env.MIGRATION_DATABASE_URL || required(process.env,"DATABASE_URL");
const pool = new pg.Pool({connectionString});
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(await readFile(new URL("./schema.sql",import.meta.url),"utf8"));
  await client.query("COMMIT");
  console.log("CS pilot schema is ready.");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
