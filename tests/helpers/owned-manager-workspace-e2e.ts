import { createClient } from "@supabase/supabase-js";
import { expect, type Page } from "@playwright/test";
import type { PortalWorkspace, WorkspacePayload } from "../../src/lib/workspaces/types";
import { E2E_ACCOUNTS } from "../fixtures";
import { establishActivePortal, signIn } from "./auth";

export const SOFTWARE_FIXTURE_PROPERTY_IDS = ["mgr-test-alder", "mgr-test-birch", "mgr-test-cedar", "mgr-test-fir", "mgr-test-magnolia", "mgr-test-spruce"] as const;

/** Select the seeded manager's own default workspace, never a shared workspace. */
export async function selectOwnedManagerWorkspace(page: Page, options: { actor?: "manager" | "manager2"; requireWrite?: boolean } = {}): Promise<PortalWorkspace> {
  const actor = options.actor ?? "manager";
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (url !== "https://emstjswhotsnyksqhqyf.supabase.co" || !key) {
    throw new Error("The owned manager workspace check requires DEV Supabase credentials.");
  }
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const profile = await db.from("profiles").select("id").eq("email", E2E_ACCOUNTS[actor].email).single();
  if (profile.error || !profile.data?.id) throw new Error("Canonical manager profile is unavailable on DEV.");
  const expectedOwner = profile.data.id;
  const response = await page.request.get("/api/workspaces");
  expect(response.ok(), "Authenticated workspace read").toBe(true);
  const payload = await response.json() as WorkspacePayload;
  const candidates = payload.workspaces.filter((workspace) =>
    workspace.owned && workspace.isDefault && workspace.ownerUserId === expectedOwner && workspace.propertyIds.length > 0,
  );
  expect(candidates, "Canonical manager must own exactly one populated default workspace").toHaveLength(1);
  const workspace = candidates[0]!;
  const selection = await page.request.post("/api/workspaces", { data: { action: "select", id: workspace.id } });
  expect(selection.ok(), "Select the owned workspace").toBe(true);
  const selected = await page.request.get("/api/workspaces");
  expect(selected.ok(), "Read selected workspace").toBe(true);
  const selectedPayload = await selected.json() as WorkspacePayload;
  expect(selectedPayload.activeWorkspaceId).toBe(workspace.id);
  const active = selectedPayload.workspaces.find((item) => item.id === selectedPayload.activeWorkspaceId);
  expect(active?.ownerUserId).toBe(expectedOwner);
  expect(active?.owned).toBe(true);
  expect(selectedPayload.plan?.unknown).toBe(false);
  if (actor === "manager") expect(selectedPayload.plan?.tier).toBe("business");
  else expect(["pro", "business"]).toContain(selectedPayload.plan?.tier);
  if (options.requireWrite) {
    expect(active?.readOnly === true, "Server-derived active workspace must be writable").toBe(false);
    const service = await db.from("portal_workspaces").select("id").eq("owner_user_id", expectedOwner).eq("is_service", true);
    expect(service.error).toBeNull();
    expect(service.data, "Software fixture must not own an account-wide managed lock").toHaveLength(0);
    const roles = await db.from("profile_roles").select("role").eq("user_id", expectedOwner);
    expect(roles.error).toBeNull();
    expect(roles.data).toEqual([{ role: "manager" }]);
    const staff = await db.from("platform_service_settings").select("owner_user_id").eq("owner_user_id", expectedOwner);
    expect(staff.error).toBeNull();
    expect(staff.data).toHaveLength(0);
    if (actor === "manager2") {
      const properties = await db.from("manager_property_records").select("id,manager_user_id,workspace_id").in("id", [...SOFTWARE_FIXTURE_PROPERTY_IDS]);
      expect(properties.error).toBeNull();
      expect(properties.data).toHaveLength(SOFTWARE_FIXTURE_PROPERTY_IDS.length);
      expect(properties.data?.every((row) => row.manager_user_id === expectedOwner && row.workspace_id === workspace.id), "Exact software catalog must belong to the selected fixture workspace").toBe(true);
    }
  }
  return workspace;
}

/** Wait for the provider to hydrate the selected workspace on the target page. */
export async function expectOwnedWorkspaceReady(page: Page, workspace: PortalWorkspace): Promise<void> {
  const switcher = page.getByRole("button", { name: `Switch workspace: ${workspace.name}`, exact: true }).first();
  await expect(switcher).toBeVisible();
  await expect(switcher).toBeEnabled();
  await expect(page.getByRole("button", { name: "Switch workspace: Loading…", exact: true })).toHaveCount(0);
}

/** Normal email sign-in for the existing isolated software fixture, never a staff or managed-lock bypass. */
export async function signInWritableSoftwareManager(page: Page): Promise<PortalWorkspace> {
  if (E2E_ACCOUNTS.manager2.email !== "manager2@test.proplane.local") throw new Error("Software mutation fixtures refuse account overrides.");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url !== "https://emstjswhotsnyksqhqyf.supabase.co" || !key) throw new Error("Software fixture requires exact DEV credentials.");
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const profile = await db.from("profiles").select("manager_id,phone,phone_verified_at").eq("email", E2E_ACCOUNTS.manager2.email).single();
  expect(profile.error, "Existing canonical manager2 profile must load").toBeNull();
  expect(profile.data?.manager_id).toBe("MGR-TESTE2E2");
  expect(profile.data?.phone, "Manager2 needs its bounded synthetic phone prerequisite").toBe("+12025550131");
  expect(profile.data?.phone_verified_at).toBeTruthy();
  await page.context().clearCookies();
  await signIn(page, E2E_ACCOUNTS.manager2.email, E2E_ACCOUNTS.manager2.password, "/portal/dashboard");
  await establishActivePortal(page, "manager", "/portal/dashboard");
  return selectOwnedManagerWorkspace(page, { actor: "manager2", requireWrite: true });
}
