import "server-only";

/** Supabase Postgres password from env (supports legacy and Vercel-style names). */
export function readSupabaseDatabasePassword(): string {
  return (
    process.env.SUPABASE_DATABASE_PASSWORD?.trim() ||
    process.env.Supabase_Database_Password?.trim() ||
    process.env.SUPABASE_DB_PASSWORD?.trim() ||
    ""
  );
}

/** Build a pooler connection string from Supabase project env vars. */
export function postgresConnectionStringFromEnv(): string | null {
  const direct = process.env.DATABASE_URL?.trim() || process.env.POSTGRES_URL?.trim();
  if (direct) {
    // node-postgres connection-string SSL options overwrite the explicit `ssl`
    // object, so an old ?sslmode=require must not disable CA verification.
    const parsed = new URL(direct);
    if ([...parsed.searchParams.keys()].some((key) => key.toLowerCase().startsWith("ssl"))) {
      throw new Error("Remove SSL query parameters from the database URL; configure SUPABASE_DB_SSL_CA instead.");
    }
    return direct;
  }

  const password = readSupabaseDatabasePassword();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!password || !url) return null;

  const ref = new URL(url).hostname.split(".")[0];
  const host =
    process.env.SUPABASE_DB_HOST?.trim() ||
    process.env.SUPABASE_POOLER_HOST?.trim() ||
    `aws-1-us-west-2.pooler.supabase.com`;
  const port = process.env.SUPABASE_DB_PORT?.trim() || "6543";
  const user = process.env.SUPABASE_DB_USER?.trim() || `postgres.${ref}`;
  const database = process.env.SUPABASE_DB_NAME?.trim() || "postgres";
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

export function postgresSslFromEnv(): { rejectUnauthorized: true; ca?: string } {
  if (process.env.SUPABASE_DB_SSL === "false") {
    throw new Error("Unencrypted database connections are disabled.");
  }
  const ca = process.env.SUPABASE_DB_SSL_CA?.trim().replace(/\\n/g, "\n");
  return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
}
