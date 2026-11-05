/** Read-only credential/catalog prerequisite, run before the first signup mutation. */
import { isAbsolute } from "node:path";
import { lstatSync } from "node:fs";
import { connectSignupObserver } from "./signup-proof-observer.mjs";
import { pathToFileURL } from "node:url";

export async function preflightSignupCleanup(env = process.env, connect = connectSignupObserver) {
  if (env.NEXT_PUBLIC_SUPABASE_URL !== "https://emstjswhotsnyksqhqyf.supabase.co" || !env.SUPABASE_DB_SSL_CA_FILE || !isAbsolute(env.SUPABASE_DB_SSL_CA_FILE)) throw new Error("Signup cleanup access preflight refused.");
  const ca = lstatSync(env.SUPABASE_DB_SSL_CA_FILE);
  if (!ca.isFile() || ca.isSymbolicLink()) throw new Error("Signup cleanup access preflight refused.");
  const client = await connect(env);
  try {

    const proof = await client.query("select * from signup_fixture_guard.session_counts($1::uuid)", ["00000000-0000-0000-0000-000000000000"]);
    if (proof.rows.length !== 1 || proof.rows[0]?.project_ref !== "emstjswhotsnyksqhqyf") throw new Error("Signup cleanup target proof refused.");
    await client.query("select conname from pg_constraint where contype='f' limit 0");
    await client.query("select a.attname from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid=a.attrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and a.attnum>0 and not a.attisdropped limit 0");
  } finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await preflightSignupCleanup(); console.log("Signup cleanup read-only access preflight passed."); }
  catch { console.error("Signup cleanup read-only access preflight refused; no signup may run."); process.exitCode = 1; }
}
