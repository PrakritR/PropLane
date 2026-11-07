import { expect, type APIRequestContext } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { PUBLIC_TOUR_FIXTURE } from "./seed-public-tour-fixture.mjs";
import { pacificCalendarDateYmd } from "../../src/lib/pacific-time";

/** Read-only discovery: never publishes or changes a shared listing to make a test pass. */
export async function ownedPublicProperty(
  request: APIRequestContext,
  options?: { requiresTourSelection?: boolean },
): Promise<{ id: string; title: string }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url !== "https://emstjswhotsnyksqhqyf.supabase.co" || !key) {
    throw new Error("Owned public property E2E requires the dedicated dev/test project.");
  }
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: owner, error: ownerError } = await db.from("profiles").select("id, manager_id, role").eq("email", PUBLIC_TOUR_FIXTURE.managerEmail).single();
  if (ownerError || !owner || owner.manager_id !== PUBLIC_TOUR_FIXTURE.managerAxisId || owner.role !== "manager") throw new Error("Canonical manager fixture is missing.");
  const { data: rows, error } = await db.from("manager_property_records").select("id, manager_user_id, property_data, row_data, workspace_id")
    .eq("id", PUBLIC_TOUR_FIXTURE.propertyId).eq("manager_user_id", owner.id).eq("status", "live").is("test_workspace_id", null).order("id");
  if (error || !rows?.length) throw new Error("Canonical manager has no published fixture property.");
  const { data: identity, error: identityError } = await db.auth.admin.getUserById(owner.id);
  const { data: roles, error: rolesError } = await db.from("profile_roles").select("role").eq("user_id", owner.id);
  if (identityError || identity.user?.email !== PUBLIC_TOUR_FIXTURE.managerEmail || identity.user?.app_metadata?.e2eFixture !== PUBLIC_TOUR_FIXTURE.marker || rolesError || roles?.length !== 1 || roles[0].role !== "manager") throw new Error("Public fixture identity marker/role mismatch.");
  for (const row of rows) {
    if (row.property_data?.e2eFixture !== PUBLIC_TOUR_FIXTURE.marker || row.row_data?.e2eFixture !== PUBLIC_TOUR_FIXTURE.marker || row.workspace_id !== PUBLIC_TOUR_FIXTURE.workspaceId) throw new Error("Public fixture ownership marker mismatch.");
    expect(row.manager_user_id).toBe(owner.id);
    const response = await request.get(`/api/public/property-lead?propertyId=${encodeURIComponent(row.id)}`);
    expect(response.status(), "Dedicated public fixture must resolve").not.toBe(404);
    expect(response.ok(), "Public fixture projection must load").toBe(true);
    const body = await response.json() as { property?: {
      id?: string; title?: string; buildingName?: string; address?: string;
      listingSubmission?: { v?: number; rooms?: { id?: string; name?: string }[] };
    } };
    expect(body.property?.id).toBe(row.id);
    expect(body.property?.title).toBeTruthy();
    if (options?.requiresTourSelection) {
      const property = body.property!;
      const rooms = property.listingSubmission?.v === 1 ? property.listingSubmission.rooms ?? [] : [];
      if (rooms.filter((room) => room.id?.trim() && room.name?.trim()).length < 2) continue;
      const params = new URLSearchParams({ propertyId: row.id, buildingName: property.buildingName ?? "", address: property.address ?? "" });
      const availability = await request.get(`/api/public/property-tour-availability?${params}`);
      expect(availability.ok(), "Public tour availability must load").toBe(true);
      const { slotHosts } = await availability.json() as { slotHosts: Record<string, { userId?: string }[]> };
      const todayPacific = pacificCalendarDateYmd();
      if (!Object.entries(slotHosts).some(([key, hosts]) => /^\d{4}-\d{2}-\d{2}:\d+$/.test(key) && key.split(":")[0] >= todayPacific && hosts.some((host) => host.userId === owner.id))) continue;
    }
    return { id: row.id, title: body.property!.title! };
  }
  throw new Error(options?.requiresTourSelection
    ? "No canonical manager public fixture has multiple named rooms and an upcoming open tour slot."
    : "No canonical manager published fixture passes the anonymous listing projection.");
}
