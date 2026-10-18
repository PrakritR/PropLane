#!/usr/bin/env node
/**
 * One-number migration step 4: create the PropLane Service workspace (admin account, one per city).
 *
 *   node --env-file=.env.local scripts/one-number/create-service-workspace.mjs --target dev --name "PropLane Seattle" --city Seattle
 *   ... --apply                              write it
 *   ... --owner-user-id <uuid>               only to SEED the service owner when platform_service_settings is empty
 *
 * Built against W15's contract (migration 20261018260000_admin_service_workspaces.sql, branch on/admin-service):
 *   * platform_service_settings (singleton) names the ONE service-owner account; the row wins over any env var;
 *   * a service workspace is an ordinary portal_workspaces row owned by that account (is_service = true, city);
 *   * create_portal_service_workspace(p_owner, p_name, p_city) is the only writer (service_role).
 * If that migration is not applied the script refuses and says so; it never creates a workspace another way.
 *
 * Idempotent by name (case-insensitive): re-running finds the workspace and writes nothing.
 * It does NOT move any property. The captain adds properties from the Ambika, Vinod, Prakrit and other accounts
 * after reviewing, through the product. Admin operators reach the workspace as Admin members (admin portal, Team).
 * The workspace texts on the same shared PropLane line as everyone: no number is provisioned or reserved here.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchAll, isMissingSchema } from "./lib/db.mjs";
import { UsageError } from "./lib/args.mjs";
import { bootstrap, isMain, runMain } from "./lib/runtime.mjs";
import { GuardError } from "./lib/target.mjs";

const SCRIPT = "create-service-workspace";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const here = dirname(fileURLToPath(import.meta.url));

export class ServiceRefusal extends GuardError {}

function primaryAdminEmail() {
  try {
    const source = readFileSync(join(here, "..", "..", "src", "lib", "auth", "primary-admin.ts"), "utf8");
    return /PRIMARY_ADMIN_EMAIL\s*=\s*"([^"]+)"/.exec(source)?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/** Mirrors userHoldsAdminRole (src/lib/auth/admin-role.ts): profile_roles admin, legacy profiles.role, or the primary-admin email. */
export async function holdsAdminRole(db, userId, primaryEmail = primaryAdminEmail()) {
  const [roles, profile] = await Promise.all([
    db.from("profile_roles").select("user_id").eq("role", "admin").eq("user_id", userId).maybeSingle(),
    db.from("profiles").select("id, email, role").eq("id", userId).maybeSingle(),
  ]);
  if (roles.error || profile.error) throw new Error("could not read the account's roles");
  if (roles.data) return true;
  if (!profile.data) return false;
  if (String(profile.data.role ?? "").trim().toLowerCase() === "admin") return true;
  return Boolean(primaryEmail) && String(profile.data.email ?? "").trim().toLowerCase() === primaryEmail;
}

export function cleanName(value) {
  const v = String(value ?? "").trim().replace(/\s+/g, " ");
  return v.length >= 1 && v.length <= 80 ? v : null;
}

export async function run(argv, deps = {}) {
  const { flags, db, log } = bootstrap(
    SCRIPT,
    argv,
    { strings: ["name", "city", "owner-user-id"] },
    { write: (f) => Boolean(f.apply), deps },
  );
  const apply = Boolean(flags.apply);
  const name = cleanName(flags.name);
  if (!name) throw new UsageError('--name "<workspace name>" (1-80 characters) is required.');
  const cityRaw = flags.city === undefined ? null : cleanName(flags.city);
  if (flags.city !== undefined && !cityRaw) throw new UsageError("--city must be 1-80 characters.");
  const city = cityRaw;
  const report = deps.report ?? {};

  // 1. The service owner.
  const settings = await db.from("platform_service_settings").select("owner_user_id").eq("singleton", true).maybeSingle();
  if (settings.error) {
    if (isMissingSchema(settings.error)) {
      throw new ServiceRefusal("platform_service_settings does not exist on this project: apply migration 20261018260000_admin_service_workspaces.sql (npm run db:push) first.");
    }
    throw new Error(`platform_service_settings: ${settings.error.message}`);
  }
  let ownerId = settings.data?.owner_user_id ?? null;
  const asked = String(flags["owner-user-id"] ?? deps.env?.PROPLANE_SERVICE_OWNER_USER_ID ?? process.env.PROPLANE_SERVICE_OWNER_USER_ID ?? "").trim();
  if (ownerId) {
    if (asked && asked.toLowerCase() !== String(ownerId).toLowerCase()) {
      throw new ServiceRefusal(`The service owner is already ${ownerId}; the stored row always wins. Refusing to use ${asked}.`);
    }
    log(`${SCRIPT}: service owner ${ownerId} (from platform_service_settings)`);
  } else {
    if (!UUID.test(asked)) throw new ServiceRefusal("No service owner is configured. Pass --owner-user-id <uuid> (an existing admin account) to seed it.");
    const exists = await db.from("profiles").select("id").eq("id", asked).maybeSingle();
    if (exists.error) throw new Error(`profiles: ${exists.error.message}`);
    if (!exists.data) throw new ServiceRefusal(`Account ${asked} does not exist.`);
    if (!(await holdsAdminRole(db, asked))) throw new ServiceRefusal(`Account ${asked} does not hold the admin role; the service owner must.`);
    log(`${SCRIPT}: service owner would be seeded as ${asked} (admin account verified)`);
    ownerId = asked;
    report.seedOwner = true;
    if (apply) {
      const seeded = await db.from("platform_service_settings").upsert({ singleton: true, owner_user_id: ownerId }, { onConflict: "singleton", ignoreDuplicates: true });
      if (seeded.error) throw new Error(`platform_service_settings: ${seeded.error.message}`);
      const again = await db.from("platform_service_settings").select("owner_user_id").eq("singleton", true).maybeSingle();
      ownerId = again.data?.owner_user_id ?? null;
      if (!ownerId) throw new Error("could not confirm the service owner after seeding");
    }
  }
  report.ownerUserId = ownerId;

  // 2. Idempotent by name.
  const owned = await fetchAll(db, "portal_workspaces", "id, name, city, is_service, is_default", { filter: (q) => q.eq("owner_user_id", ownerId) });
  if (owned.missing) throw new ServiceRefusal("portal_workspaces.is_service / city are missing: apply the W15 migration first.");
  const same = owned.rows.find((w) => String(w.name).trim().toLowerCase() === name.toLowerCase());
  if (same) {
    if (!same.is_service) throw new ServiceRefusal(`"${same.name}" already exists for the service owner but is not a service workspace; refusing to repurpose it.`);
    log(`${SCRIPT}: "${same.name}" already exists (${same.id}${same.city ? `, ${same.city}` : ""}). Nothing to do.`);
    report.workspaceId = same.id;
    report.created = false;
    return 0;
  }

  // 3. Create.
  log(`${SCRIPT}: ${apply ? "creating" : "would create"} service workspace "${name}"${city ? ` (${city})` : ""} owned by ${ownerId}; no property is moved, no number is reserved`);
  report.created = false;
  if (!apply) {
    log(`${SCRIPT}: dry run, nothing written. Re-run with --apply to write.`);
    return 0;
  }
  const created = await db.rpc("create_portal_service_workspace", { p_owner: ownerId, p_name: name, p_city: city });
  if (created.error || !created.data) throw new Error(`create_portal_service_workspace: ${created.error?.message ?? "no id returned"}`);
  report.workspaceId = String(created.data);
  report.created = true;
  log(`${SCRIPT}: created workspace ${report.workspaceId}. Add admin operators from the admin portal (Service, Team); properties come later, by the captain.`);
  return 0;
}

if (isMain(import.meta.url)) await runMain(SCRIPT, () => run(process.argv.slice(2)));
