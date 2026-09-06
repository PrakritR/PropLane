import pg from "pg";
import { postgresConnectionStringFromEnv, postgresSslFromEnv } from "../supabase-db-connection.mjs";
import { assertCalendarBackfillTarget, protectCalendarTokens } from "./calendar-backfill";
import { connectNonproductionDatabase, nonproductionDatabaseConfig } from "./nonproduction-database.mjs";

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--apply") || args.length > 1) throw new Error("Use no arguments for dry run, or --apply for dev/staging.");
  const apply = args.includes("--apply");
  const cliLogin = process.env.SECURITY_DATABASE_CLI_LOGIN === "1";
  const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  let client: pg.Client;
  if (cliLogin) {
    const ref = new URL(projectUrl).hostname.split(".")[0];
    if (projectUrl.replace(/\/$/, "") !== `https://${ref}.supabase.co`) throw new Error("Hosted project required.");
    client = await connectNonproductionDatabase(nonproductionDatabaseConfig(ref));
  } else {
    const connectionString = postgresConnectionStringFromEnv();
    if (!connectionString) throw new Error("Database credentials are required.");
    assertCalendarBackfillTarget(connectionString, projectUrl, apply);
    client = new pg.Client({ connectionString, ssl: postgresSslFromEnv(), connectionTimeoutMillis: 10000 });
    await client.connect();
  }
  try {
    await client.query(apply ? "begin" : "begin read only");
    await client.query("set local role postgres");
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '5s'");
    const columns = await client.query("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'manager_automation_settings'");
    const names = new Set(columns.rows.map((row) => row.column_name));
    const column = names.has("google_calendar");
    const fallback = names.has("row_data");
    if (!column && !fallback) throw new Error("Calendar storage is unavailable.");
    const fields = ["manager_user_id", ...(column ? ["google_calendar"] : []), ...(fallback ? ["row_data"] : [])];
    // Lock before reading in apply mode so OAuth refreshes cannot be overwritten.
    const rows = await client.query(`select ${fields.join(", ")} from public.manager_automation_settings${apply ? " for update" : ""}`);
    let changedRows = 0;
    let plaintextTokens = 0;
    for (const row of rows.rows) {
      const patches: Record<string, unknown> = {};
      if (column) {
        const result = protectCalendarTokens(row.google_calendar, row.manager_user_id);
        plaintextTokens += result.plaintext;
        if (result.changed) patches.google_calendar = result.value;
      }
      if (fallback && row.row_data && typeof row.row_data === "object" && !Array.isArray(row.row_data)) {
        const result = protectCalendarTokens(row.row_data.google_calendar, row.manager_user_id);
        plaintextTokens += result.plaintext;
        if (result.changed) patches.row_data = { ...row.row_data, google_calendar: result.value };
      }
      const keys = Object.keys(patches);
      if (!keys.length) continue;
      changedRows++;
      if (apply) {
        const sets = keys.map((key, index) => `${key} = $${index + 1}::jsonb`);
        if (names.has("updated_at")) sets.push("updated_at = now()");
        await client.query(`update public.manager_automation_settings set ${sets.join(", ")} where manager_user_id = $${keys.length + 1}`, [...keys.map((key) => JSON.stringify(patches[key])), row.manager_user_id]);
      }
    }
    await client.query(apply ? "commit" : "rollback");
    // Aggregate counts only: never identifiers, emails, tokens, URLs or keys.
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", scannedRows: rows.rowCount, changedRows, plaintextTokens }));
  } catch {
    await client.query("rollback").catch(() => undefined);
    throw new Error("Calendar backfill failed; transaction rolled back. Check credentials, schema and encryption keys without logging secrets.");
  } finally {
    await client.end();
  }
}

main().catch(() => {
  console.error("Calendar backfill failed. Verify the target, verified TLS configuration and encryption key ring. No credential details are logged.");
  process.exitCode = 1;
});
