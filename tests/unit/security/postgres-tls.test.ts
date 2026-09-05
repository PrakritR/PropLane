import { afterEach, describe, expect, it, vi } from "vitest";
import * as server from "@/lib/supabase/postgres-connection";
// @ts-expect-error Operational scripts use native ESM without declarations.
import * as cli from "../../../scripts/supabase-db-connection.mjs";

afterEach(() => vi.unstubAllEnvs());
describe.each([["server", server], ["CLI", cli]])("Postgres %s TLS", (_, helpers) => {
  it("verifies server certificates by default", () => {
    vi.stubEnv("SUPABASE_DB_SSL", "");
    vi.stubEnv("SUPABASE_DB_SSL_CA", "");
    expect(helpers.postgresSslFromEnv()).toEqual({ rejectUnauthorized: true });
  });
  it("accepts the explicitly trusted CA without disabling verification", () => {
    vi.stubEnv("SUPABASE_DB_SSL", "");
    vi.stubEnv("SUPABASE_DB_SSL_CA", "certificate\\nline");
    expect(helpers.postgresSslFromEnv()).toEqual({ rejectUnauthorized: true, ca: "certificate\nline" });
  });
  it("rejects disabling encryption", () => {
    vi.stubEnv("SUPABASE_DB_SSL", "false");
    expect(() => helpers.postgresSslFromEnv()).toThrow();
  });
  it.each(["sslmode=require", "sslmode=no-verify", "ssl=false", "sslrootcert=/tmp/untrusted"])("rejects URL SSL overrides %s", (query) => {
    vi.stubEnv("DATABASE_URL", `postgres://u:p@db.example.test/db?${query}`);
    expect(() => helpers.postgresConnectionStringFromEnv()).toThrow();
  });
});
