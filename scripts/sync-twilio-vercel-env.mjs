#!/usr/bin/env node
/**
 * Validate and optionally push Twilio env vars from .env.local to one Vercel
 * environment. Production is the safe default; credentials are never copied
 * into Preview/Development unless that target is named explicitly.
 *
 *   node --env-file=.env.local scripts/sync-twilio-vercel-env.mjs
 *   node --env-file=.env.local scripts/sync-twilio-vercel-env.mjs --apply
 *   node --env-file=.env.local scripts/sync-twilio-vercel-env.mjs --target preview --apply
 *
 * Requires: vercel CLI linked to project axis-2 (`npx vercel link --project axis-2`).
 */

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  SMS_TWILIO_KEYS,
  validateTwilioProviderEnvironment,
} from "./lib/sms-cutover-config.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const ENV_FILE = resolve(ROOT, ".env.local");

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function argumentValue(name) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const target = String(argumentValue("--target") ?? "production").trim();
const apply = process.argv.includes("--apply");
if (!new Set(["production", "preview", "development"]).has(target)) {
  console.error("Invalid --target. Use production, preview, or development.");
  process.exit(2);
}
const fileEnv = parseEnvFile(ENV_FILE);
const env = { ...fileEnv, ...process.env };

const errors = validateTwilioProviderEnvironment(env, { target });
if (errors.length > 0) {
  for (const error of errors) console.error(`✗ ${error}`);
  process.exit(1);
}

console.log(`Twilio Vercel sync plan: ${target}`);
for (const key of SMS_TWILIO_KEYS) console.log(`- ${key}`);
if (!apply) {
  console.log("\nDry run only. Re-run with --apply to update this one environment atomically.");
  process.exit(0);
}

function vercel(args, input) {
  const result = spawnSync("npx", ["vercel", ...args], {
    cwd: ROOT,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return result;
}

for (const key of SMS_TWILIO_KEYS) {
  const value = String(env[key]).trim();
  // `env add --force` replaces the target value without the remove-then-add
  // availability gap the previous script created.
  const add = vercel(["env", "add", key, target, "--force", "--sensitive", "--yes"], value);
  if (add.status !== 0) {
    console.error(`Failed ${key} (${target}):`, add.stderr || add.stdout);
    process.exit(1);
  }
  console.log(`✓ ${key} → ${target}`);
}

console.log(`\nDone. Redeploy ${target} for changes to take effect.`);
