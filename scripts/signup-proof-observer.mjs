/** DEV-only read observer. The credential must belong to the reviewed catalog/session role. */
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { verifyInstallation, rejectUnreviewedDefiners } from "./security/signup-fixture-observer-provision.mjs";
export function signupObserverConfig(env = process.env) {
  let url;
  try { url = new URL(env.SIGNUP_PROOF_OBSERVER_URL ?? ""); } catch { throw new Error("Signup observer credential unavailable."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "aws-1-us-west-2.pooler.supabase.com" || url.port !== "5432" || decodeURIComponent(url.username) !== "signup_fixture_observer.emstjswhotsnyksqhqyf" || !url.password || url.pathname !== "/postgres" || url.search || url.hash || !env.SUPABASE_DB_SSL_CA_FILE || !path.isAbsolute(env.SUPABASE_DB_SSL_CA_FILE)) throw new Error("Signup observer credential refused.");
  return { host: url.hostname, port: 5432, user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: "postgres", ssl: { rejectUnauthorized: true, ca: readFileSync(env.SUPABASE_DB_SSL_CA_FILE, "utf8") }, connectionTimeoutMillis: 10000 };
}
export async function connectSignupObserver(env = process.env) {
  const client = new pg.Client(signupObserverConfig(env));
  try {
    await client.connect();
    if (!client.connection.stream.encrypted || !client.connection.stream.authorized) throw new Error();
    await client.query("BEGIN READ ONLY");
    const role = await client.query("select current_user as role,session_user as session_role,current_database() as database");
    if (role.rows[0]?.role !== "signup_fixture_observer" || role.rows[0]?.session_role !== "signup_fixture_observer" || role.rows[0]?.database !== "postgres") throw new Error();
    await verifyInstallation(client);
    await rejectUnreviewedDefiners(client);
    // Verification is short-lived. HTTP/storage guards between observations must
    // never leave this connection idle inside a SQL transaction. The verified
    // role default keeps subsequent autocommit observations read-only.
    await client.query("COMMIT");
    return client;
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end().catch(() => undefined);
    throw new Error("Signup observer connection refused.");
  }
}
