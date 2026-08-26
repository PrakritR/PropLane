#!/usr/bin/env node

/**
 * Read-only managed-SMS production cutover gate.
 *
 * This deliberately never changes Vercel, Supabase, or Twilio. It proves that
 * the application-side prerequisites are present and calls out the provider /
 * scheduler checks that still require external evidence before either runtime
 * kill switch is enabled.
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  assessVercelEnvironmentNames,
  inspectSmsCutoverEnvironment,
  normalizeSmsCutoverPhase,
  SMS_ACTIVATION_KEYS,
  SMS_FOUNDATION_KEYS,
} from "./lib/sms-cutover-config.mjs";

const root = resolve(import.meta.dirname, "..");
const target = process.argv.includes("--preview") ? "preview" : "production";
const phaseArgument = process.argv.find((arg) => arg.startsWith("--phase="));
const phase = normalizeSmsCutoverPhase(phaseArgument?.slice("--phase=".length) || "dormant");
const ENV_RESULT_PREFIX = "SMS_CUTOVER_ENV_RESULT=";

if (!phase) {
  process.stderr.write(
    "Invalid --phase. Use dormant, scheduler-ready, provisioning-canary, or runtime-canary.\n",
  );
  process.exit(2);
}

if (process.argv.includes("--inspect-current-env")) {
  const report = inspectSmsCutoverEnvironment(process.env, { target, phase });
  process.stdout.write(`${ENV_RESULT_PREFIX}${JSON.stringify(report)}\n`);
  process.exit(report.ok ? 0 : 1);
}

const requiredMigrations = [
  "20260825120000_sms_control_plane.sql",
  "20260826120000_sms_inbound_replay_state.sql",
  "20260826130000_manager_sms_contacts.sql",
  "20260826140000_resident_sms_session_identity.sql",
];

function run(command, args) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runVercelEnvironmentList() {
  const args = ["vercel", "env", "ls", target, "--no-color"];
  if (process.platform === "darwin") {
    // Vercel CLI 54 suppresses its table when stdout is a pipe. `script` gives
    // it a pseudo-TTY while this process still captures the output for a real
    // gate. Never interpret an empty table as "every variable is missing".
    return run("script", ["-q", "/dev/null", "npx", ...args]);
  }
  return run("npx", args);
}

function line(mark, message) {
  process.stdout.write(`${mark} ${message}\n`);
}

let failed = false;
let warned = false;

process.stdout.write(`Managed SMS cutover readiness (${target}, phase=${phase})\n\n`);

const envResult = runVercelEnvironmentList();
if (envResult.status !== 0) {
  line("✗", `Could not read Vercel ${target} environment names.`);
  const detail = (envResult.stderr || envResult.stdout).trim().split("\n").at(-1);
  if (detail) line(" ", detail);
  failed = true;
} else {
  const output = `${envResult.stdout}\n${envResult.stderr}`;
  const foundation = assessVercelEnvironmentNames(output, SMS_FOUNDATION_KEYS);
  const activation = assessVercelEnvironmentNames(output, SMS_ACTIVATION_KEYS);
  if (!foundation.enumerated) {
    line("✗", `Vercel ${target} environment names could not be enumerated.`);
    line(" ", "Run `npx vercel env ls production` directly and restore CLI/network access before relying on this gate.");
    failed = true;
  } else if (foundation.missing.length > 0) {
    line("✗", `Missing provider/callback environment names: ${foundation.missing.join(", ")}`);
    failed = true;
  } else {
    line("✓", "Provider, signature, callback, Verify, and cron environment names exist.");
  }
  if (activation.enumerated && activation.missing.length > 0) {
    line("!", `Runtime remains fail-closed; activation names not configured: ${activation.missing.join(", ")}`);
    warned = true;
  } else if (activation.enumerated) {
    line("✓", "Provisioning, scheduler, and runtime kill-switch names exist.");
  }
}

if (!failed) {
  const inspected = run("npx", [
    "vercel",
    "env",
    "run",
    "--environment",
    target,
    "--",
    "node",
    "scripts/check-sms-cutover-readiness.mjs",
    "--inspect-current-env",
    target === "preview" ? "--preview" : "--production",
    `--phase=${phase}`,
  ]);
  const markerLine = `${inspected.stdout}\n${inspected.stderr}`
    .split("\n")
    .find((row) => row.startsWith(ENV_RESULT_PREFIX));
  if (!markerLine) {
    line("✗", `Could not inspect Vercel ${target} environment values without exposing them.`);
    failed = true;
  } else {
    try {
      const report = JSON.parse(markerLine.slice(ENV_RESULT_PREFIX.length));
      for (const error of report.errors ?? []) line("✗", error);
      for (const warning of report.warnings ?? []) line("!", warning);
      if (report.ok) line("✓", "Deployment values, callback URLs, project identity, and phase flags are valid.");
      else failed = true;
    } catch {
      line("✗", "Vercel environment inspection returned an unreadable result.");
      failed = true;
    }
  }
}

for (const migration of requiredMigrations) {
  const path = resolve(root, "supabase/migrations", migration);
  if (!existsSync(path)) {
    line("✗", `Missing migration ${migration}.`);
    failed = true;
  }
}
if (requiredMigrations.every((name) => existsSync(resolve(root, "supabase/migrations", name)))) {
  line("✓", "Control-plane, inbound replay, and contact-store migrations are checked in.");
}

const linkedProjectPath = resolve(root, "supabase/.temp/project-ref");
const linkedProjectRef = existsSync(linkedProjectPath)
  ? readFileSync(linkedProjectPath, "utf8").trim()
  : "";
const expectedProductionRef = "qahnczmilgptcedaqype";
if (target === "production" && linkedProjectRef !== expectedProductionRef) {
  line("✗", "Supabase CLI is not linked to the production project; remote migration state was not guessed.");
  line(" ", "Link production deliberately, run this gate, then restore the documented dev/test link.");
  failed = true;
} else {
  const migrationResult = run("npx", ["supabase", "migration", "list", "--linked"]);
  if (migrationResult.status !== 0) {
    line("✗", "Could not prove the linked database applied the required migrations.");
    line(" ", "Restore Supabase CLI database authentication, then rerun this gate.");
    failed = true;
  } else {
    const migrationOutput = migrationResult.stdout;
    const missingRemote = requiredMigrations
      .map((name) => name.slice(0, 14))
      .filter((version) => {
        const appliedRow = migrationOutput
          .split("\n")
          .find((row) => row.includes(version));
        if (!appliedRow) return true;
        const columns = appliedRow.split("|").map((part) => part.trim());
        return columns.length < 2 || columns[1] !== version;
      });
    if (missingRemote.length > 0) {
      line("✗", `Required migrations are not proven remote: ${missingRemote.join(", ")}`);
      failed = true;
    } else {
      line("✓", "Required SMS migrations are applied to the linked database.");
    }
  }
}

const vercelConfig = JSON.parse(readFileSync(resolve(root, "vercel.json"), "utf8"));
const outboxCron = (vercelConfig.crons ?? []).find((cron) => cron.path === "/api/cron/sms-outbox");
if (!outboxCron) {
  line("✗", "The daily sms-outbox safety-net cron is missing from vercel.json.");
  failed = true;
} else {
  line("✓", `Daily outbox safety net is present (${outboxCron.schedule}).`);
  line("!", "A monitored five-minute external scheduler still needs independent verification.");
  warned = true;
}

for (const route of [
  "src/app/api/twilio/inbound/route.ts",
  "src/app/api/twilio/status/route.ts",
  "src/app/api/twilio/events/route.ts",
  "src/app/api/cron/sms-outbox/route.ts",
]) {
  if (!existsSync(resolve(root, route))) {
    line("✗", `Missing cutover route ${route}.`);
    failed = true;
  }
}

process.stdout.write("\nProvider evidence still required before activation:\n");
line("-", "Inbound/status/Event Streams URLs match the deployed canonical URLs and signed URL validation.");
line("-", "Restricted API key permissions, service/campaign identity, sender-pool attachment, and carrier registration are verified.");
line("-", "Pilot owner has paid entitlement and is the only DB allowlist member before the canary.");
line("-", "Five-minute scheduler alerts on non-2xx plus unknown/backlog response fields; then STOP/START/retry/delivery canary cases pass.");

if (failed) {
  process.stdout.write("\nBLOCKED: production activation prerequisites are incomplete or unproven.\n");
  process.exitCode = 1;
} else if (warned) {
  process.stdout.write("\nREADY FOR MANUAL CANARY CHECKS; runtime remains intentionally fail-closed.\n");
} else {
  process.stdout.write("\nAPPLICATION-SIDE CUTOVER CHECKS PASSED. Complete the provider canary before expanding rollout.\n");
}
