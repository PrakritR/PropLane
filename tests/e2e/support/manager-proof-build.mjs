/** Builds with a source fingerprint; no provider egress or production env. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import dotenv from "dotenv";
export function productFingerprint() {
  const list = spawnSync("git", ["ls-files", "-z", "src", "public", "next.config.ts", "package.json", "package-lock.json", "tsconfig.json"], { encoding: "buffer" });
  if (list.status !== 0) throw new Error("Cannot enumerate product source.");
  const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "src", "public"], { encoding: "utf8" });
  if (untracked.status !== 0 || untracked.stdout.trim()) throw new Error("Untracked product files prevent a proof build.");
  const hash = createHash("sha256");
  for (const name of list.stdout.toString().split("\0").filter(Boolean).sort()) { hash.update(name).update("\0").update(readFileSync(name)).update("\0"); }
  return hash.digest("hex");
}
export function proofEnvironment(source) {
  const env = { ...source, NEXT_PUBLIC_APP_URL: "http://localhost:3007", RESEND_API_KEY: "re_dummy_auth_browser_no_delivery", RESEND_FROM: "Auth Proof <proof@example.invalid>" };
  for (const key of new Set([...Object.keys(env).filter((key) => /^(TWILIO_|CLAW_|STRIPE_|CHECKR_|PERSONA_|OPENAI_|ANTHROPIC_|META_)/.test(key)), "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET", "TWILIO_MESSAGING_SERVICE_SID", "CLAW_MESSENGER_API_KEY"])) env[key] = "";
  return env;
}
if (process.argv[1]?.endsWith("manager-proof-build.mjs")) {
  if ([".env.production", ".env.production.local"].some(existsSync)) throw new Error("Production env files forbidden.");
  for (const file of [".env.test", ".env.local", ".env"]) if (existsSync(file)) dotenv.config({ path: file, quiet: true, override: false });
  if (process.env.NEXT_PUBLIC_SUPABASE_URL !== "https://emstjswhotsnyksqhqyf.supabase.co") throw new Error("Exact DEV project required.");
  const marker = ".next/auth-proof-build.json";
  rmSync(marker, { force: true });
  const before = productFingerprint();
  const result = spawnSync("npm", ["run", "build"], { env: proofEnvironment(process.env), stdio: "inherit" });
  if (result.status !== 0 || before !== productFingerprint() || !existsSync(".next/BUILD_ID")) throw new Error("Build failed or product source changed.");
  writeFileSync(marker, JSON.stringify({ fingerprint: before, project: "emstjswhotsnyksqhqyf", origin: "http://localhost:3007", buildId: readFileSync(".next/BUILD_ID", "utf8").trim() }), { mode: 0o600 });
}
