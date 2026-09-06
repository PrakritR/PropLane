import { nonproductionDatabaseConfig, connectNonproductionDatabase } from "./nonproduction-database.mjs";
import pg from "pg";
import { postgresConnectionStringFromEnv, postgresSslFromEnv } from "../supabase-db-connection.mjs";
import { assertCalendarBackfillTarget } from "./calendar-backfill";
import { protectApplicantRecord } from "./applicant-backfill";

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--apply") || args.length > 1) throw new Error("Invalid arguments.");
  const apply = args.includes("--apply");
  const cliLogin = process.env.SECURITY_DATABASE_CLI_LOGIN === "1";
  let client: pg.Client;
  if (cliLogin) {
    const target = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    if (target.protocol !== "https:" || !target.hostname.endsWith(".supabase.co")) throw new Error("Invalid database target.");
    const ref = target.hostname.slice(0, -".supabase.co".length);
    client = await connectNonproductionDatabase(nonproductionDatabaseConfig(ref));
  } else {
    const connectionString = postgresConnectionStringFromEnv();
    if (!connectionString) throw new Error("Database configuration required.");
    assertCalendarBackfillTarget(connectionString, process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", apply);
    client = new pg.Client({ connectionString, ssl: postgresSslFromEnv(), connectionTimeoutMillis: 10000 });
    await client.connect();
  }
  try {
    await client.query(apply ? "begin" : "begin read only");
    if (cliLogin) await client.query("set local role postgres");
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '5s'");
    const rows = await client.query(`select id, manager_user_id, row_data from public.manager_application_records${apply ? " for update" : ""}`);
    let changedRows = 0;
    let plaintextFields = 0;
    for (const row of rows.rows) {
      const result = protectApplicantRecord(row.row_data, row.id, row.manager_user_id);
      plaintextFields += result.plaintextFields;
      if (!result.changed) continue;
      changedRows++;
      if (apply) await client.query("update public.manager_application_records set row_data = $1::jsonb, updated_at = now() where id = $2", [JSON.stringify(result.value), row.id]);
    }
    await client.query(apply ? "commit" : "rollback");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", scannedRows: rows.rowCount, changedRows, plaintextFields }));
  } catch {
    await client.query("rollback").catch(() => undefined);
    throw new Error("Applicant backfill failed and rolled back.");
  } finally {
    await client.end();
  }
}

main().catch(() => {
  console.error("Applicant backfill failed. Verify target, trusted TLS, row ownership and encryption keys without logging sensitive values.");
  process.exitCode = 1;
});
