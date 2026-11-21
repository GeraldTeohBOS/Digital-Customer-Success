import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

export function openCanonicalDatabase(path = fileURLToPath(new URL("../data/canonical.sqlite3", import.meta.url)), {writable = false} = {}) {
  const connection = new DatabaseSync(path, {readOnly: !writable});
  connection.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000");
  const hasTable = name => Boolean(connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  if (writable && hasTable("cs_expansion_target") && !hasTable("cs_outreach_draft")) {
    connection.exec("BEGIN IMMEDIATE");
    try {
      if (!hasTable("cs_outreach_draft")) connection.exec(readFileSync(new URL("../data/outreach.sql",import.meta.url),"utf-8"));
      connection.exec("COMMIT");
    } catch (error) {
      connection.exec("ROLLBACK");
      connection.close();
      throw error;
    }
  }
  return {
    outreach:hasTable("cs_outreach_draft"),
    all(sql, parameters = []) { return connection.prepare(sql).all(...parameters); },
    ...(writable ? {write(sql, parameters = []) { return connection.prepare(sql).run(...parameters).changes; }} : {}),
    close() { connection.close(); },
  };
}
