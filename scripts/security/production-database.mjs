import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import pg from "pg";

export const PRODUCTION_PROJECT = "qahnczmilgptcedaqype";

export function assertProductionUrl(url) {
  if (url !== `https://${PRODUCTION_PROJECT}.supabase.co` && url !== `https://${PRODUCTION_PROJECT}.supabase.co/`) {
    throw new Error("Exact production project URL required.");
  }
}

/** Parse privately captured CLI output. Never include it in logs or exceptions. */
export function productionConfigFromCliOutput(output, ca) {
  const values = {};
  for (const name of ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"]) {
    const matches = [...output.matchAll(new RegExp(`export ${name}="([^"\\r\\n]*)"`, "g"))];
    if (matches.length !== 1 || !matches[0][1]) throw new Error("Unsupported database login format.");
    values[name] = matches[0][1];
  }
  const direct = values.PGHOST === `db.${PRODUCTION_PROJECT}.supabase.co` && values.PGUSER === "cli_login_postgres";
  const pooler = /^(?:[a-z0-9-]+\.){1,2}pooler\.supabase\.com$/.test(values.PGHOST) &&
    values.PGUSER === `cli_login_postgres.${PRODUCTION_PROJECT}`;
  if ((!direct && !pooler) || values.PGDATABASE !== "postgres" || values.PGPORT !== "5432") {
    throw new Error("Production database endpoint mismatch.");
  }
  return { host: values.PGHOST, port: 5432, user: values.PGUSER, password: values.PGPASSWORD,
    database: "postgres", ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) }, connectionTimeoutMillis: 10000 };
}

export function productionDatabaseConfig() {
  assertProductionUrl(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const ca = process.env.SUPABASE_DB_SSL_CA?.replace(/\\n/g, "\n") ||
    (process.env.SUPABASE_DB_SSL_CA_FILE ? readFileSync(process.env.SUPABASE_DB_SSL_CA_FILE, "utf8") : undefined);
  const result = spawnSync("npx", ["-y", "supabase@2.116.0", "db", "dump", "--project-ref", PRODUCTION_PROJECT,
    "--data-only", "--schema", "public", "--dry-run", "--yes"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 });
  if (result.status !== 0) throw new Error("Production CLI authentication failed.");
  return productionConfigFromCliOutput(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, ca);
}

export async function connectProductionDatabase(config) {
  const client = new pg.Client(config);
  try {
    await client.connect();
    if (!client.connection.stream.encrypted || !client.connection.stream.authorized) throw new Error("TLS required.");
    return client;
  } catch {
    await client.end().catch(() => undefined);
    throw new Error("Unable to establish a verified production database connection.");
  }
}
