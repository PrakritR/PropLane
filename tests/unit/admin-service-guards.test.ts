/**
 * Source guards for PropLane Service: the migration's cap exemption is the service owner only, the create
 * function refuses everyone else, and no manager-side route grows an admin branch.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(root, dir))) {
    const rel = path.join(dir, name);
    const st = statSync(path.join(root, rel));
    if (st.isDirectory()) out.push(...walk(rel));
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

describe("migration 20261018260000", () => {
  const sql = read("supabase/migrations/20261018260000_admin_service_workspaces.sql");

  it("exempts only the stored service owner from the 10-workspace ceiling, and keeps the ceiling for everyone else", () => {
    const fn = sql.slice(sql.indexOf("create or replace function public.enforce_portal_workspace_limit"), sql.indexOf("create or replace function public.create_portal_service_workspace"));
    expect(fn).toMatch(/exists \(select 1 from public\.platform_service_settings where owner_user_id = new\.owner_user_id\)/);
    expect(fn).toMatch(/>= 10 then/);
    expect(fn.indexOf("platform_service_settings")).toBeLessThan(fn.indexOf(">= 10"));
  });

  it("creates service workspaces only for the service owner, and only service_role can call it", () => {
    expect(sql).toMatch(/not exists \(\s*select 1 from public\.platform_service_settings where owner_user_id = p_owner\s*\)[\s\S]*?using errcode = '42501'/);
    expect(sql).toMatch(/revoke all on function public\.create_portal_service_workspace\(uuid, text, text\) from public, anon, authenticated;/);
    expect(sql).toMatch(/grant execute on function public\.create_portal_service_workspace\(uuid, text, text\) to service_role;/);
  });

  it("locks the settings table to service_role and is idempotent", () => {
    expect(sql).toMatch(/alter table public\.platform_service_settings enable row level security;/);
    expect(sql).toMatch(/revoke all on public\.platform_service_settings from anon, authenticated;/);
    expect(sql).not.toMatch(/grant [a-z, ]+ on public\.platform_service_settings to (anon|authenticated)/);
    expect(sql).toMatch(/create table if not exists public\.platform_service_settings/);
    expect(sql).toMatch(/add column if not exists is_service/);
  });
});

describe("no admin branch inside the manager side", () => {
  // The base's admin-aware manager-side routes (all pre-existing). A NEW file here means a new admin branch
  // in a manager route: the admin role is not the all-owners read (AGENTS.md § Admin borrows).
  const ALLOWED = new Set([
    "src/app/api/portal/application-photos/route.ts",
    "src/app/api/portal/delete-resident-access/route.ts",
    "src/app/api/portal/dispatch-proposals/route.ts",
    "src/app/api/portal/inbox-attachments/route.ts",
    "src/app/api/portal/inbox-eligible-contacts/route.ts",
    "src/app/api/portal/payment-reminder-history/route.ts",
    "src/app/api/portal/purge-orphaned-records/route.ts",
    "src/app/api/portal/resident-approval/route.ts",
    "src/app/api/portal/send-application-completion-reminder/route.ts",
    "src/app/api/portal/send-inbox-message/route.ts",
    "src/app/api/portal/send-manager-application-started/route.ts",
    "src/app/api/portal/send-payment-reminder/route.ts",
    "src/app/api/portal/send-task-reminder/route.ts",
    "src/app/api/portal/send-vendor-visit-email/route.ts",
    "src/app/api/portal/service-requests/send-reminder/route.ts",
    "src/app/api/portal/tours-export/route.ts",
    "src/app/api/portal/work-orders/en-route/route.ts",
    "src/app/api/portal/work-orders/mark-done/route.ts",
    "src/app/api/portal/work-orders/send-reminder/route.ts",
    "src/app/api/portal/work-orders/set-vendor-price/route.ts",
    "src/app/api/portal/work-orders/visit-scheduled/route.ts",
    "src/app/api/pro/purge-orphaned-co-manager-links/route.ts",
  ]);
  const MANAGER_SIDE = ["src/app/api/manager", "src/app/api/portal", "src/app/api/workspaces", "src/app/api/pro", "src/app/portal"];

  it("adds no admin-gate use to a manager route", () => {
    const hits = MANAGER_SIDE.flatMap(walk).filter((f) => /\b(isAdminUser|userHoldsAdminRole|requireAdminRoute|requirePlatformAdmin)\b/.test(read(f)));
    expect(hits.filter((f) => !ALLOWED.has(f))).toEqual([]);
  });

  it("never lets a manager route reach the Service layer or its owner config", () => {
    const hits = MANAGER_SIDE.flatMap(walk).filter((f) => /@\/lib\/service\/|PROPLANE_SERVICE_OWNER_USER_ID/.test(read(f)));
    expect(hits).toEqual([]);
  });

  it("provisions, reserves and exempts no number for service workspaces", () => {
    const files = walk("src/lib/service").concat(walk("src/app/api/admin/service-workspaces"), ["src/components/portal/admin-service-panel.tsx"]);
    for (const f of files) {
      expect(read(f), f).not.toMatch(/provisionManagerNumber|provisionNumberForWorkspace|ensureManagerNumberRecord|reconcileManagerSmsEntitlement/);
    }
    for (const f of ["src/lib/sms/work-numbers.server.ts", "src/lib/sms/manager-sms-entitlement.server.ts", "src/lib/sms/manager-number-provisioning.server.ts"].filter((p) => existsSync(p))) {
      expect(read(f), f).not.toMatch(/isPlatformServiceOwner|@\/lib\/service\//);
    }
  });

  it("every Service and PropLane line verb starts with the admin gate", () => {
    for (const f of ["src/app/api/admin/service-workspaces/route.ts", "src/app/api/admin/proplane-line/route.ts"]) {
      const src = read(f);
      const verbs = src.match(/export async function (GET|POST|PATCH|PUT|DELETE)/g) ?? [];
      const gates = src.match(/await requireAdminRoute\(\)/g) ?? [];
      expect(verbs.length, f).toBeGreaterThan(0);
      expect(gates.length, f).toBe(verbs.length);
    }
  });
});

describe("attach an existing workspace", () => {
  it("adds no migration of its own: it uses only the columns of 20261018260000 / 20261018260100", () => {
    expect(readdirSync(path.join(root, "supabase/migrations")).filter((f) => f.startsWith("2026101826"))).toEqual([
      "20261018260000_admin_service_workspaces.sql",
      "20261018260100_service_owner_of_record.sql",
    ]);
  });

  it("the Service routes re-derive admin status on every verb, attach included", () => {
    const route = read("src/app/api/admin/service-workspaces/route.ts");
    expect(route).toMatch(/case "attach":/);
    const lib = read("src/lib/service/service-workspaces.server.ts");
    const attach = lib.slice(lib.indexOf("export async function attachWorkspaceToService"), lib.indexOf("export type ServiceAttachCandidate"));
    expect(attach).toMatch(/userHoldsAdminRole\(db, operatorUserId\)/);
    // The audit row is written before the flag moves, and the attach never writes the owner column or a property row.
    expect(attach.indexOf("writeAuditLog")).toBeLessThan(attach.indexOf('.update({ is_service: true'));
    expect(attach).not.toMatch(/\.update\(\{[^}]*owner_user_id/);
    expect(attach).not.toMatch(/manager_property_records/);
  });
});
