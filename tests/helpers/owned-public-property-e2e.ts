import { expect, type APIRequestContext } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { E2E_ACCOUNTS } from "../fixtures";

/** Read-only discovery: never publishes or changes a shared listing to make a test pass. */
export async function ownedPublicProperty(request: APIRequestContext): Promise<{ id: string; title: string }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || new URL(url).hostname !== "emstjswhotsnyksqhqyf.supabase.co" || !key) {
    throw new Error("Owned public property E2E requires the dedicated dev/test project.");
  }
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: owner, error: ownerError } = await db.from("profiles").select("id").eq("email", E2E_ACCOUNTS.manager.email).single();
  if (ownerError || !owner) throw new Error("Canonical manager fixture is missing.");
  const { data: rows, error } = await db.from("manager_property_records").select("id, manager_user_id")
    .eq("manager_user_id", owner.id).eq("status", "live").is("test_workspace_id", null).order("id");
  if (error || !rows?.length) throw new Error("Canonical manager has no published fixture property.");
  for (const row of rows) {
    expect(row.manager_user_id).toBe(owner.id);
    const response = await request.get(`/api/public/property-lead?propertyId=${encodeURIComponent(row.id)}`);
    if (response.status() === 404) continue;
    expect(response.ok(), "Public fixture projection must load").toBe(true);
    const body = await response.json() as { property?: { id?: string; title?: string } };
    expect(body.property?.id).toBe(row.id);
    expect(body.property?.title).toBeTruthy();
    return { id: row.id, title: body.property!.title! };
  }
  throw new Error("No canonical manager published fixture passes the anonymous listing projection.");
}
