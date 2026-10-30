/** Builds with a source fingerprint; no provider egress or production env. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import dotenv from "dotenv";
export function productFingerprint() {
  const list = spawnSync("git", ["ls-files", "-z", "src", "public", "next.config.ts", "package.json", "package-lock.json", "tsconfig.json"], { encoding: "buffer" });
  if (list.status !== 0) throw new Error("Cannot enumerate product source.");
  const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "src", "public"], { encoding: "utf8" });
  if (untracked.status !== 0 || untracked.stdout.trim()) throw new Error("Untracked product files prevent a proof build.");
  const hash = createHash("sha256");
  const harness = ["tests/e2e/support/no-delivery-preload.mjs", "tests/e2e/support/manager-proof-build.mjs", "tests/e2e/support/manager-two-phase-runner.mjs", "tests/e2e/support/manager-two-phase-cleanup.ts"];
  for (const name of [...list.stdout.toString().split("\0").filter(Boolean), ...harness].sort()) { hash.update(name).update("\0").update(readFileSync(name)).update("\0"); }
  return hash.digest("hex");
}
export function proofEnvironment(source) {
  const env = { ...source, NEXT_PUBLIC_APP_URL: "http://localhost:3007", RESEND_API_KEY: "re_dummy_auth_browser_no_delivery", RESEND_FROM: "Auth Proof <proof@example.invalid>" };
  for (const key of new Set([...Object.keys(env).filter((key) => /^(TWILIO_|CLAW_|STRIPE_|CHECKR_|PERSONA_|OPENAI_|ANTHROPIC_|META_)/.test(key)), "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET", "TWILIO_MESSAGING_SERVICE_SID", "CLAW_MESSENGER_API_KEY"])) env[key] = "";
  for (const file of readdirSync(".").filter((name) => /^\.env(?:\.|$)/.test(name))) {
    if (file.startsWith(".env.production")) throw new Error("Production env files forbidden.");
    for (const key of Object.keys(dotenv.parse(readFileSync(file)))) if (/^(TWILIO_|CLAW_|STRIPE_|CHECKR_|PERSONA_|OPENAI_|ANTHROPIC_|META_)/.test(key)) env[key] = "";
  }
  return env;
}
export function validatedEnvironment(source) {
  if (readdirSync(".").some((name) => name.startsWith(".env.production"))) throw new Error("Production env files forbidden.");
  const test = dotenv.parse(readFileSync(".env.test"));
  const url = "https://emstjswhotsnyksqhqyf.supabase.co";
  if (test.NEXT_PUBLIC_SUPABASE_URL !== url) throw new Error("DEV env target mismatch.");
  for (const name of ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
    const parts = (test[name] ?? "").split(".");
    if (parts.length !== 3 || JSON.parse(Buffer.from(parts[1], "base64url").toString()).ref !== "emstjswhotsnyksqhqyf") throw new Error("DEV credential mismatch.");
  }
  const env = proofEnvironment({ ...source, ...test, SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_CANONICAL_APP_URL: "http://localhost:3007", NODE_OPTIONS: "--max-old-space-size=6144", E2E_TESTS_ENABLED: "1" });
  for (const [name, fallback] of Object.entries({ E2E_ADMIN_EMAIL: "admin@test.proplane.local", E2E_MANAGER_EMAIL: "manager@test.proplane.local", E2E_RESIDENT_EMAIL: "resident@test.proplane.local", E2E_VENDOR_EMAIL: "vendor@test.proplane.local", E2E_MANAGER2_EMAIL: "manager2@test.proplane.local", E2E_EVERYTHING_EMAIL: "testeverything@test.proplane.local" })) {
    const value = source[name] || fallback;
    if (!/^[a-z0-9._+-]+@test\.proplane\.local$/.test(value)) throw new Error("Noncanonical QA email.");
    env[name] = value;
  }
  return env;
}
if (process.argv[1]?.endsWith("manager-proof-build.mjs")) {
  const env = validatedEnvironment(process.env);
  const marker = ".next/auth-proof-build.json";
  rmSync(marker, { force: true });
  const before = productFingerprint();
  const result = spawnSync(process.execPath, ["node_modules/next/dist/bin/next", "build", "--webpack"], { env, stdio: "inherit" });
  if (result.status !== 0 || before !== productFingerprint() || !existsSync(".next/BUILD_ID")) throw new Error("Build failed or product source changed.");
  writeFileSync(marker, JSON.stringify({ fingerprint: before, project: "emstjswhotsnyksqhqyf", origin: "http://localhost:3007", buildId: readFileSync(".next/BUILD_ID", "utf8").trim() }), { mode: 0o600 });
}
