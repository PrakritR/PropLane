/** Builds with a source fingerprint; no provider egress or production env. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import dotenv from "dotenv";
import path from "node:path";
export function productFingerprint() {
  const list = spawnSync("git", ["ls-files", "-z", "src", "public", "next.config.ts", "postcss.config.mjs", "package.json", "package-lock.json", "tsconfig.json"], { encoding: "buffer" });
  if (list.status !== 0) throw new Error("Cannot enumerate product source.");
  const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "src", "public"], { encoding: "utf8" });
  if (untracked.status !== 0 || untracked.stdout.trim()) throw new Error("Untracked product files prevent a proof build.");
  const hash = createHash("sha256");
  const harness = ["tests/e2e/support/no-delivery-preload.mjs", "tests/e2e/support/manager-proof-build.mjs", "tests/e2e/support/manager-two-phase-runner.mjs", "tests/e2e/support/manager-two-phase-cleanup.ts", "tests/e2e/support/manager-catalog-preflight.ts", "tests/helpers/synthetic-manager-cleanup.ts", "tests/helpers/synthetic-workspace-preflight.ts", "tests/e2e/support/draft-fk-catalog.json"];
  for (const name of [...list.stdout.toString().split("\0").filter(Boolean), ...harness].sort()) { hash.update(name).update("\0").update(readFileSync(name)).update("\0"); }
  return hash.digest("hex");
}
export function validatedEnvironment(source, cwd = process.cwd()) {
  const test=dotenv.parse(readFileSync(path.join(cwd,'.env.test')));
  const target='emstjswhotsnyksqhqyf';
  if(test.NEXT_PUBLIC_SUPABASE_URL!==`https://${target}.supabase.co`)throw Error('DEV env target mismatch');
  for(const name of ['NEXT_PUBLIC_SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY']){
    if(!test[name])throw Error('Required DEV credential absent');
    const parts=test[name].split('.');
    if(parts.length!==3 || JSON.parse(Buffer.from(parts[1],'base64url').toString()).ref!==target)throw Error('Credential project mismatch');
  }
  if(readdirSync(cwd).some(x=>x.startsWith('.env.production')))throw Error('Production env file refused');
  const env={...source,...test,NODE_ENV:'production',NODE_OPTIONS:'--max-old-space-size=6144',
    SUPABASE_URL:test.NEXT_PUBLIC_SUPABASE_URL,NEXT_PUBLIC_APP_URL:'http://localhost:3007',NEXT_PUBLIC_CANONICAL_APP_URL:'http://localhost:3007',
    RESEND_API_KEY:'re_dummy_auth_browser_no_delivery',RESEND_FROM:'Auth Proof <proof@example.invalid>',
    PLAYWRIGHT_SKIP_WEBSERVER:'1',PLAYWRIGHT_BASE_URL:'http://localhost:3007',E2E_TESTS_ENABLED:'1',CHROME_DEVTOOLS_AXI_SESSION:'auth-proof'};
  const smsKeys = new Set(['TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_API_KEY_SID','TWILIO_API_KEY_SECRET','TWILIO_MESSAGING_SERVICE_SID','CLAW_MESSENGER_API_KEY']);
  for (const key of Object.keys(env)) if (/^(TWILIO_|CLAW_|STRIPE_|CHECKR_|PERSONA_|OPENAI_|ANTHROPIC_|META_)/.test(key)) smsKeys.add(key);
  for (const name of readdirSync(cwd).filter(x => /^\.env(?:\.|$)/.test(x))) {
    const file = path.join(cwd,name);
    if (!statSync(file).isFile()) continue;
    for (const key of Object.keys(dotenv.parse(readFileSync(file)))) if (/^(TWILIO_|CLAW_|STRIPE_|CHECKR_|PERSONA_|OPENAI_|ANTHROPIC_|META_)/.test(key)) smsKeys.add(key);
  }
  for (const key of smsKeys) env[key]='';
  env.CLAW_MESSENGER_HTTP_BASE='https://claw-messenger.onrender.com';
  env.CLAW_MESSENGER_WS_URL='wss://claw-messenger.onrender.com/ws';
  const canonicalEmails = {E2E_ADMIN_EMAIL:'admin@test.proplane.local', E2E_MANAGER_EMAIL:'manager@test.proplane.local', E2E_RESIDENT_EMAIL:'resident@test.proplane.local', E2E_VENDOR_EMAIL:'vendor@test.proplane.local', E2E_MANAGER2_EMAIL:'manager2@test.proplane.local', E2E_EVERYTHING_EMAIL:'testeverything@test.proplane.local'};
  for (const [name, fallback] of Object.entries(canonicalEmails)) {
    const selected = source[name] || fallback;
    if(!/^[a-z0-9._+-]+@test\.proplane\.local$/.test(selected)) throw Error('Noncanonical QA email override refused');
    env[name]=selected;
  }
  // Additional test-only provider isolation; these keys are never required by this proof.
  for (const key of Object.keys(env)) if (/^(STRIPE_|CHECKR_|PERSONA_|OPENAI_|ANTHROPIC_|META_)/.test(key)) env[key]='';
  return env;
}
export function envDigest(cwd = process.cwd(), source = process.env) {
  const env = validatedEnvironment(source, cwd);
  const values = Object.keys(env).filter((key) => key.startsWith("NEXT_PUBLIC_")).sort().map((key) => [key, env[key]]);
  const hash = createHash("sha256");
  for (const name of readdirSync(cwd).filter((name) => /^\.env(?:\.|$)/.test(name) && !name.startsWith(".env.production")).sort()) hash.update(name).update("\0").update(readFileSync(path.join(cwd, name))).update("\0");
  return hash.update(JSON.stringify(values)).digest("hex");
}
if (process.argv[1]?.endsWith("manager-proof-build.mjs")) {
  const env = validatedEnvironment(process.env);
  const marker = ".next/auth-proof-build.json";
  rmSync(marker, { force: true });
  const before = productFingerprint();
  const beforeEnv = envDigest();
  const result = spawnSync(process.execPath, ["node_modules/next/dist/bin/next", "build", "--webpack"], { env, stdio: "inherit" });
  if (result.status !== 0 || before !== productFingerprint() || beforeEnv !== envDigest() || !existsSync(".next/BUILD_ID")) throw new Error("Build failed or product source changed.");
  writeFileSync(marker, JSON.stringify({ fingerprint: before, envDigest: beforeEnv, project: "emstjswhotsnyksqhqyf", origin: "http://localhost:3007", buildId: readFileSync(".next/BUILD_ID", "utf8").trim() }), { mode: 0o600 });
}
