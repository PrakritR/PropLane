/**
 * Import the Sales workbook's room rosters into PropLane.
 *
 * Two steps, on purpose. `sales-workbook-roster.ts` reads the sheet and
 * `sales-workbook-import-plan.ts` decides what to create; this script only EXECUTES a plan it is
 * handed. That means the whole plan can be printed and read before a single row is written, which
 * is what makes a dry run worth anything when the target holds real tenancies.
 *
 * **It sends nothing.** Every occupant gets an account and no email, SMS, or invitation. The plan
 * type has no notify variant, so there is nothing here that could send even by mistake — see the
 * comment at the top of `sales-workbook-import-plan.ts`. These are real people who never agreed to
 * hear from PropLane, and an invitation cannot be recalled.
 *
 * Usage — dry run first, always:
 *
 *   node --env-file=.env.local scripts/import-sales-workbook.mjs --plan plan.json
 *   ALLOW_IMPORT_TARGET=<project-ref> MANAGER_USER_ID=<uuid> \
 *     node --env-file=.env.local scripts/import-sales-workbook.mjs --plan plan.json --write
 *
 * The target guard mirrors `verify-role-escalation-closed.mjs`: `ALLOW_IMPORT_TARGET` must NAME
 * the project ref parsed from the Supabase URL. Naming it is the confirmation — it cannot be
 * satisfied by a stray truthy value, and pointing at the wrong environment fails closed rather
 * than writing 100 rows into the wrong database.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2);
const planPath = args[args.indexOf("--plan") + 1];
const write = args.includes("--write");

if (!planPath || planPath.startsWith("--")) {
  console.error("Usage: --plan <plan.json> [--write]");
  process.exit(2);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
const managerUserId = process.env.MANAGER_USER_ID?.trim() ?? "";

function targetFromUrl(raw) {
  try {
    const host = new URL(raw).host;
    const hosted = /^([a-z0-9-]+)\.supabase\.(co|in|red)$/i.exec(host);
    return hosted ? hosted[1] : host;
  } catch {
    return "";
  }
}

const target = targetFromUrl(url);
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const actions = plan.actions ?? [];
const warnings = plan.warnings ?? [];

const counts = actions.reduce((acc, a) => ({ ...acc, [a.type]: (acc[a.type] ?? 0) + 1 }), {});
console.log(`Target project: ${target || "(unparseable)"}`);
console.log(`Plan: ${JSON.stringify(counts)}`);
console.log(`Warnings: ${warnings.length}`);
for (const w of warnings) console.log(`  ${w.propertyKey} ${w.room}: ${w.message}`);

if (!write) {
  // The default. Nothing below this line runs without --write.
  console.log("\nDRY RUN — nothing was written. Re-run with --write to apply.");
  process.exit(0);
}

const allowed = process.env.ALLOW_IMPORT_TARGET?.trim() ?? "";
if (!target || allowed !== target) {
  console.error(
    `\nRefusing to write: this creates real accounts, leases, and charges.\n` +
      `Set ALLOW_IMPORT_TARGET to the project ref it should touch, and confirm which environment that is.\n` +
      `  Supabase URL resolves to: ${target || "(unparseable)"}\n` +
      `  ALLOW_IMPORT_TARGET is:   ${allowed || "(unset)"}`,
  );
  process.exit(2);
}
if (!serviceKey || !managerUserId) {
  console.error("\nRefusing to write: SUPABASE_SERVICE_ROLE_KEY and MANAGER_USER_ID are both required.");
  process.exit(2);
}

const db = createClient(url, serviceKey, { auth: { persistSession: false } });
const nowIso = new Date().toISOString();

/** A stable id per planned record, so re-running the import updates rather than duplicating. */
const idFor = (a, suffix = "") =>
  `sheet-import:${a.propertyKey}:${a.room.replace(/\s+/g, "").toLowerCase()}${suffix}`;

let written = 0;
const failures = [];

for (const action of actions) {
  try {
    if (action.type === "charge") {
      const id = idFor(action, `:${action.kind}`);
      const { error } = await db.from("portal_household_charge_records").upsert(
        {
          id,
          manager_user_id: managerUserId,
          resident_email: "",
          status: "pending",
          row_data: {
            id,
            createdAt: nowIso,
            residentName: action.residentName,
            residentEmail: "",
            residentUserId: null,
            propertyId: action.propertyKey,
            propertyLabel: action.propertyKey,
            managerUserId,
            kind: action.kind,
            title: action.kind === "rent" ? "Rent" : action.kind === "utilities" ? "Utilities" : action.kind,
            amountLabel: `$${(action.amountCents / 100).toFixed(2)}`,
            balanceLabel: `$${(action.amountCents / 100).toFixed(2)}`,
            status: "pending",
            recurring: action.recurring,
            importedFrom: "sales-workbook",
          },
          updated_at: nowIso,
        },
        { onConflict: "id" },
      );
      if (error) throw new Error(error.message);
      written += 1;
      continue;
    }

    // Rooms, accounts, and leases are recorded on the property record so a single re-run stays
    // idempotent. They are deliberately written WITHOUT any notification path.
    if (action.type === "room" || action.type === "account" || action.type === "lease") {
      const id = idFor(action, `:${action.type}`);
      const { error } = await db.from("portal_lease_pipeline_records").upsert(
        {
          id,
          manager_user_id: managerUserId,
          row_data: { ...action, id, managerUserId, importedFrom: "sales-workbook", updatedAtIso: nowIso },
          updated_at: nowIso,
        },
        { onConflict: "id" },
      );
      if (error) throw new Error(error.message);
      written += 1;
    }
  } catch (e) {
    // Keep going and report at the end: a partial import that says exactly what failed is far
    // easier to finish by hand than one that stopped silently in the middle.
    failures.push(`${action.type} ${action.propertyKey} ${action.room}: ${e instanceof Error ? e.message : e}`);
  }
}

console.log(`\nWrote ${written} of ${actions.length} records.`);
if (failures.length) {
  console.log(`Failed ${failures.length}:`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
