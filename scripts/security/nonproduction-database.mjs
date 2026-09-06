import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import pg from "pg";

export const NONPRODUCTION_PROJECTS = ["emstjswhotsnyksqhqyf", "xwszcafaontidfgznlxd"];

/** CLI output contains a short-lived password: capture it, never log it. */
export function nonproductionDatabaseConfig(ref) {
  if (!NONPRODUCTION_PROJECTS.includes(ref)) throw new Error("Development or staging project required.");
  const ca = process.env.SUPABASE_DB_SSL_CA?.replace(/\\n/g, "\n") ||
    (process.env.SUPABASE_DB_SSL_CA_FILE ? readFileSync(process.env.SUPABASE_DB_SSL_CA_FILE, "utf8") : undefined);
  const result = spawnSync("npx", ["-y", "supabase@2.116.0", "db", "dump", "--project-ref", ref,
    "--data-only", "--schema", "public", "--dry-run", "--yes"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status !== 0) throw new Error("Supabase CLI authentication failed.");
  const values = {};
  for (const name of ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"]) {
    const match = output.match(new RegExp(`export ${name}="([^"\\r\\n]*)"`));
    if (!match) throw new Error("Supabase CLI login format is unsupported.");
    values[name] = match[1];
  }
  const direct = values.PGHOST === `db.${ref}.supabase.co`;
  const pooler = values.PGHOST.endsWith(".pooler.supabase.com") && values.PGUSER === `cli_login_postgres.${ref}`;
  if ((!direct && !pooler) || values.PGDATABASE !== "postgres") throw new Error("Database endpoint mismatch.");
  return { host: values.PGHOST, port: Number(values.PGPORT), user: values.PGUSER,
    password: values.PGPASSWORD, database: values.PGDATABASE,
    ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) }, connectionTimeoutMillis: 10000 };
}

export async function connectNonproductionDatabase(config) {
  const client = new pg.Client(config);
  try {
    await client.connect();
    if (!client.connection.stream.encrypted || !client.connection.stream.authorized) {
      throw new Error("Verified client TLS is required.");
    }
    return client;
  } catch {
    await client.end().catch(() => undefined);
    throw new Error("Unable to establish a verified database connection.");
  }
}
