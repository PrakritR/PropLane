#!/usr/bin/env node
/**
 * N081 (plan-parts.html Part 13, item 3) — finds and optionally removes
 * leases/charges/services rows left behind by a resident delete that predates
 * the transactional purge (633b90975) or any other bug: a row whose
 * `resident_email` has NO `manager_application_records` row at all — in ANY
 * bucket — for that manager. That is the same "orphaned" definition N080's
 * client-side `isLinkedToDirectoryResident` (src/lib/resident-directory-scope.ts)
 * uses to HIDE these rows; this script is the companion that actually removes
 * them once the captain says so. A row still visible in `readManagerApplicationRows()`,
 * whatever its bucket — Potential, Current, Past, Rejected, or Withdrawn — is
 * never orphaned; only a resident who has no application row anywhere in this
 * manager's portfolio is.
 *
 * Reports PER WORKSPACE — grouped by `manager_user_id`, the same scope every
 * purge/orphan helper in `src/lib/auth/` already uses (a co-manager team's
 * rows all carry the owning manager's id).
 *
 * DRY RUN BY DEFAULT. Prints what would be deleted and exits 0 without
 * touching anything.
 *
 *   node --env-file=.env scripts/purge-orphaned-resident-data.mjs
 *
 * Runs freely (dry run or --apply) against dev/test and staging. Against the
 * live production project, --apply additionally requires --confirm-production
 * — the captain's own word, per the Part 13 decision:
 *
 *   node --env-file=.env scripts/purge-orphaned-resident-data.mjs --apply
 *   node --env-file=.env.production.local scripts/purge-orphaned-resident-data.mjs --apply --confirm-production
 *
 * Never touches:
 *   - a manager-entered one-off charge (id starts "hc_mgr_") — the manager
 *     entered it deliberately; it stays even for a fully deleted resident,
 *     the same exemption `isManagerAddedOneOffCharge` grants on the display
 *     side (manager-payments-scope.ts).
 *   - an Airbnb/Booking.com occupancy import placeholder
 *     (`*@import.proplane.local`) — never a directory resident to begin with.
 *   - `manager_application_records` itself, property records, or anything
 *     not in ORPHAN_TARGETS below. This script only cleans the four tables
 *     N081 names: leases, charges, and the two Services tables.
 */

import { createClient } from "@supabase/supabase-js";

const PROD_REF = (process.env.AXIS_PROD_SUPABASE_REF || "qahnczmilgptcedaqype").trim();

const APPLY = process.argv.includes("--apply");
const CONFIRM_PRODUCTION = process.argv.includes("--confirm-production");

function norm(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function stripQuotes(value) {
  return typeof value === "string" ? value.replace(/^"|"$/g, "").trim() : "";
}

function isImportPlaceholderEmail(email) {
  return email.endsWith("@import.proplane.local");
}

/** Mirrors `isManagerAddedOneOffCharge` (household-charges.ts) for the one column this script reads. */
function isManagerOneOffChargeId(id) {
  return typeof id === "string" && id.startsWith("hc_mgr_");
}

/** category -> table -> what counts as orphaned and how ids are chunked for delete. */
const ORPHAN_TARGETS = [
  { category: "leases", table: "portal_lease_pipeline_records" },
  { category: "charges", table: "portal_household_charge_records", exempt: (row) => isManagerOneOffChargeId(row.id) },
  { category: "services", table: "portal_work_order_records" },
  { category: "services", table: "portal_service_request_records" },
];

const url = stripQuotes(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
const serviceKey = stripQuotes(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const ref = url.replace(/^https:\/\/([^.]+).*/, "$1");
const isProduction = ref === PROD_REF;

if (APPLY && isProduction && !CONFIRM_PRODUCTION) {
  console.error(
    `Refusing: --apply against the live production project (${PROD_REF}) needs --confirm-production too ` +
      "(the captain's own word — see plan-parts.html Part 13, decision 3). Dry run is always allowed.",
  );
  process.exit(2);
}

const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

async function fetchAllRows(table, columns, extra = (q) => q) {
  const pageSize = 1000;
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await extra(db.from(table).select(columns)).range(from, from + pageSize - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

async function main() {
  const applications = await fetchAllRows("manager_application_records", "manager_user_id, resident_email");

  // Every application row of ANY bucket counts as "still in the directory" —
  // the same definition src/lib/resident-directory-scope.ts uses, and the
  // reason: a rejected or withdrawn applicant's application row (and any real
  // charge on it) is not deleted, so it must never read as orphaned.
  const activeEmailsByManager = new Map();
  for (const row of applications) {
    const managerId = row.manager_user_id;
    const email = norm(row.resident_email);
    if (!managerId || !email) continue;
    if (!activeEmailsByManager.has(managerId)) activeEmailsByManager.set(managerId, new Set());
    activeEmailsByManager.get(managerId).add(email);
  }

  /** managerId -> { category -> { orphaned: [{table,id,email}], exempt: [...] } } */
  const perManager = new Map();
  const orphanIdsByTable = new Map();

  for (const target of ORPHAN_TARGETS) {
    const rows = await fetchAllRows(target.table, "id, manager_user_id, resident_email");
    for (const row of rows) {
      const managerId = row.manager_user_id;
      const email = norm(row.resident_email);
      if (!managerId || !email) continue;
      if (isImportPlaceholderEmail(email)) continue;
      const activeEmails = activeEmailsByManager.get(managerId);
      if (activeEmails && activeEmails.has(email)) continue;

      if (!perManager.has(managerId)) perManager.set(managerId, {});
      const forManager = perManager.get(managerId);
      if (!forManager[target.category]) forManager[target.category] = { orphaned: [], exempt: [] };

      const exempt = Boolean(target.exempt && target.exempt(row));
      const entry = { table: target.table, id: row.id, email };
      if (exempt) {
        forManager[target.category].exempt.push(entry);
        continue;
      }
      forManager[target.category].orphaned.push(entry);
      if (!orphanIdsByTable.has(target.table)) orphanIdsByTable.set(target.table, []);
      orphanIdsByTable.get(target.table).push(row.id);
    }
  }

  // Attach the manager's own email for a readable report.
  const managerIds = [...perManager.keys()];
  const managerEmailById = new Map();
  if (managerIds.length > 0) {
    const profiles = await fetchAllRows("profiles", "id, email", (q) => q.in("id", managerIds));
    for (const p of profiles) managerEmailById.set(p.id, p.email ?? "");
  }

  let totalOrphaned = 0;
  let totalExempt = 0;
  const report = [];
  for (const [managerId, categories] of perManager.entries()) {
    const summary = {};
    for (const [category, { orphaned, exempt }] of Object.entries(categories)) {
      summary[category] = { orphaned: orphaned.length, exempt: exempt.length };
      totalOrphaned += orphaned.length;
      totalExempt += exempt.length;
    }
    report.push({
      managerUserId: managerId,
      managerEmail: managerEmailById.get(managerId) ?? "(unknown)",
      counts: summary,
    });
  }

  console.log(
    JSON.stringify(
      {
        mode: APPLY ? "apply" : "dry-run",
        project: ref,
        isProduction,
        workspaces: report,
        totalOrphanedRows: totalOrphaned,
        totalExemptManagerOneOffCharges: totalExempt,
      },
      null,
      2,
    ),
  );

  if (!APPLY) {
    console.log(
      `Dry run only — ${totalOrphaned} orphaned row(s) across ${report.length} workspace(s) would be deleted. ` +
        "Re-run with --apply to delete (production also needs --confirm-production).",
    );
    return;
  }

  for (const [table, ids] of orphanIdsByTable.entries()) {
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const { error } = await db.from(table).delete().in("id", chunk);
      if (error) throw new Error(`${table}: ${error.message}`);
    }
    console.log(`Deleted ${ids.length} from ${table}`);
  }
  console.log(`Done. Deleted ${totalOrphaned} orphaned row(s); kept ${totalExempt} manager-entered one-off charge(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
