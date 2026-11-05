import { createClient } from "@supabase/supabase-js";
import { expect, type Page } from "@playwright/test";
import type { PortalWorkspace, WorkspacePayload } from "../../src/lib/workspaces/types";
import { E2E_ACCOUNTS } from "../fixtures";

/** Select the seeded manager's own default workspace, never a shared workspace. */
export async function selectOwnedManagerWorkspace(page: Page): Promise<PortalWorkspace> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (url !== "https://emstjswhotsnyksqhqyf.supabase.co" || !key) {
    throw new Error("The owned manager workspace check requires DEV Supabase credentials.");
  }
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const profile = await db.from("profiles").select("id").eq("email", E2E_ACCOUNTS.manager.email).single();
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
  expect(selectedPayload.plan?.tier).toBe("business");
  return workspace;
}

/** Wait for the provider to hydrate the selected workspace on the target page. */
export async function expectOwnedWorkspaceReady(page: Page, workspace: PortalWorkspace): Promise<void> {
  const switcher = page.getByRole("button", { name: `Switch workspace: ${workspace.name}`, exact: true }).first();
  await expect(switcher).toBeVisible();
  await expect(switcher).toBeEnabled();
  await expect(page.getByRole("button", { name: "Switch workspace: Loading…", exact: true })).toHaveCount(0);
}
