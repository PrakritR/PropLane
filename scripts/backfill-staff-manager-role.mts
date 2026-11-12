/**
 * One-off backfill: PropLane Service staff (an accepted `account_link_invites` seat with `is_service_seat = true`,
 * platform admins included) who hold NO `profile_roles` 'manager' row. DRY RUN by default.
 *
 *   npx tsx --env-file=.env.local scripts/backfill-staff-manager-role.mts --project-ref <ref>            # dry run
 *   npx tsx --env-file=.env.local scripts/backfill-staff-manager-role.mts --project-ref <ref> --apply    # inserts rows
 *
 * Safety: --project-ref is REQUIRED and must match the ref in NEXT_PUBLIC_SUPABASE_URL. Before any insert a JSON
 * backup of exactly what will be inserted is written to ./backups/staff-manager-role-<ref>-<timestamp>.json and read
 * back; if that fails nothing is changed. Idempotent (insert ignores conflicts). Prints user ids only.
 */
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv: string[]) {
  const i = argv.indexOf("--project-ref");
  return { projectRef: i >= 0 ? argv[i + 1] : undefined, apply: argv.includes("--apply") };
}

function refFromUrl(url: string): string {
  try {
    return new URL(url).hostname.split(".")[0] ?? "";
  } catch {
    return "";
  }
}

async function main() {
  const { projectRef, apply } = parseArgs(process.argv.slice(2));
  if (!projectRef || projectRef.startsWith("--")) throw new Error("--project-ref <ref> is required.");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  const urlRef = refFromUrl(url);
  if (urlRef !== projectRef) throw new Error(`Refusing: --project-ref does not match the environment's project (${urlRef || "unknown"}).`);

  const db = createClient(url, key, { auth: { persistSession: false } });
  const seats = await db
    .from("account_link_invites")
    .select("invitee_user_id")
    .eq("status", "accepted")
    .eq("is_service_seat", true)
    .not("invitee_user_id", "is", null);
  if (seats.error) throw new Error("Could not read service seats.");
  const staffIds = [...new Set((seats.data ?? []).map((r) => String(r.invitee_user_id)).filter(Boolean))];

  const managers = new Set<string>();
  const admins = new Set<string>();
  if (staffIds.length) {
    const roles = await db.from("profile_roles").select("user_id, role").in("user_id", staffIds).in("role", ["manager", "admin"]);
    if (roles.error) throw new Error("Could not read profile roles.");
    for (const r of roles.data ?? []) (r.role === "manager" ? managers : admins).add(String(r.user_id));
  }
  const missing = staffIds.filter((id) => !managers.has(id));
  console.log(`Project ${projectRef}: ${staffIds.length} service-seat holders, ${missing.length} without a manager role (${missing.filter((id) => admins.has(id)).length} of them platform admins).`);
  for (const id of missing) console.log(`  ${id}${admins.has(id) ? " (admin)" : ""}`);

  if (!apply) {
    console.log("Dry run: nothing written. Re-run with --apply to insert.");
    return;
  }
  if (!missing.length) {
    console.log("Nothing to do.");
    return;
  }

  const rows = missing.map((user_id) => ({ user_id, role: "manager" }));
  const dir = path.resolve("backups");
  const file = path.join(dir, `staff-manager-role-${projectRef}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ projectRef, table: "profile_roles", insert: rows }, null, 2));
    const back = JSON.parse(fs.readFileSync(file, "utf8")) as { insert?: unknown[] };
    if (back.insert?.length !== rows.length) throw new Error("backup read-back mismatch");
  } catch {
    throw new Error("Refusing to apply: the backup could not be written.");
  }
  console.log(`Backup written: ${file}`);
  const ins = await db.from("profile_roles").upsert(rows, { onConflict: "user_id,role", ignoreDuplicates: true });
  if (ins.error) throw new Error(`Insert failed: ${ins.error.code ?? "error"}`);
  console.log(`Inserted (or already present): ${rows.length}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
