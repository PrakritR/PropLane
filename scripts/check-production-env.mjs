#!/usr/bin/env node
/**
 * Fail loudly when a critical production variable is EMPTY (PRP-114).
 *
 * The July audit found 68 variables set in Vercel Production and a third of them
 * empty placeholders. Every one fails closed, so nothing was insecure — but all
 * seven crons had been 401ing since launch, no product email had ever sent, and
 * the assistant no-opped, all while working perfectly in dev. Failing closed is
 * right; failing SILENTLY is what let it run for months.
 *
 * An EMPTY variable is treated exactly like a missing one. That is the specific
 * shape of this bug: `vercel env` shows the name present, so a human scanning the
 * dashboard sees a full list and concludes it is provisioned.
 *
 * Reads names only — never a value, never a fragment of one — so it is safe in
 * CI logs.
 *
 *   node scripts/check-production-env.mjs            # audit this environment
 *   node scripts/check-production-env.mjs --list     # print the groups and exit
 */

/**
 * Grouped by the feature that goes dark, with what a manager actually loses, so
 * the failure names a consequence rather than a variable.
 */
const GROUPS = [
  {
    id: "crons",
    label: "Scheduled jobs",
    impact:
      "every Vercel cron 401s — payment reminders, scheduled messages, move-in, lease-signing and document-expiry reminders never run",
    vars: ["CRON_SECRET"],
  },
  {
    id: "email",
    label: "Email",
    impact: "no product email sends at all, including password reset, which has no other path",
    vars: ["RESEND_API_KEY", "RESEND_FROM"],
  },
  {
    id: "ai",
    label: "Assistant",
    impact: "assistant chat, AI draft replies and the SMS agents all no-op",
    vars: ["ANTHROPIC_API_KEY"],
  },
  {
    id: "supabase",
    label: "Database",
    impact: "the app cannot read or write anything",
    vars: ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
  },
  {
    id: "billing",
    label: "Billing",
    impact: "paid-tier checkout cannot complete",
    vars: ["STRIPE_SECRET_KEY"],
  },
];

/** Present in the environment AND not blank. A blank is the bug this exists for. */
function isProvisioned(name) {
  return typeof process.env[name] === "string" && process.env[name].trim() !== "";
}

function main() {
  if (process.argv.includes("--list")) {
    for (const group of GROUPS) {
      console.log(`${group.label}: ${group.vars.join(", ")}`);
    }
    return 0;
  }

  const dark = [];
  for (const group of GROUPS) {
    const missing = group.vars.filter((name) => !isProvisioned(name));
    if (missing.length > 0) dark.push({ group, missing });
  }

  if (dark.length === 0) {
    console.log(`OK   production env: all ${GROUPS.length} critical groups provisioned`);
    return 0;
  }

  for (const { group, missing } of dark) {
    console.error(`FAIL ${group.label} is dark — ${group.impact}`);
    console.error(`     empty or missing: ${missing.join(", ")}`);
  }
  console.error("");
  console.error("Set these in Vercel → Project → Settings → Environment Variables (Production),");
  console.error("then redeploy. An EMPTY value counts as unset: the name showing in the");
  console.error("dashboard is exactly how this went unnoticed for months.");
  return 1;
}

process.exit(main());
