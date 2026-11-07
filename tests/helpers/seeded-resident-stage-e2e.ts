import { createClient } from "@supabase/supabase-js";
import { expect, type Page } from "@playwright/test";
import { E2E_ACCOUNTS } from "../fixtures";
import { establishActivePortal, signIn } from "./auth";

/** Existing test:seed actors, read-only. Never changes the shared primary resident's stage. */
export async function signInSeededStageResident(page: Page, stage: "unsigned" | "signed") {
  const fixture = stage === "unsigned"
    ? { email: "marcus.chen.workflow@test.proplane.local", axisId: "AXIS-DEMMARCUSC" }
    : { email: "jordan.lee.workflow@test.proplane.local", axisId: "AXIS-DEMOJORDL" };
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url !== "https://emstjswhotsnyksqhqyf.supabase.co" || !key) throw new Error("Resident stage fixtures require the dedicated DEV project.");
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const owner = await db.from("profiles").select("id").eq("email", E2E_ACCOUNTS.manager.email).single();
  const resident = await db.from("profiles").select("id,manager_id,phone,phone_verified_at").eq("email", fixture.email).single();
  expect(owner.error, "Canonical manager must exist").toBeNull();
  expect(resident.error, "Dedicated stage resident must be seeded").toBeNull();
  expect(resident.data?.manager_id).toBe(fixture.axisId);
  expect(resident.data?.phone, "Existing stage actor requires its seeded phone prerequisite").toBe(stage === "unsigned" ? "+12025550132" : "+12025550133");
  expect(resident.data?.phone_verified_at, "Seeded verification is synthetic setup, never delivery proof").toBeTruthy();
  const applications = await db.from("manager_application_records").select("id,manager_user_id,row_data").eq("resident_email", fixture.email);
  expect(applications.error).toBeNull();
  expect(applications.data?.length).toBeGreaterThan(0);
  expect(applications.data?.every((row) => row.manager_user_id === owner.data!.id), "Stage fixture must belong only to the canonical manager").toBe(true);
  const application = applications.data!.find((row) => row.id === fixture.axisId);
  expect(application?.row_data?.bucket).toBe("approved");
  expect(application?.row_data?.residentUserId).toBe(resident.data!.id);
  const leases = await db.from("portal_lease_pipeline_records").select("manager_user_id,row_data").eq("resident_user_id", resident.data!.id);
  expect(leases.error).toBeNull();
  expect(leases.data?.length).toBeGreaterThan(0);
  expect(leases.data?.every((row) => row.manager_user_id === owner.data!.id), "Stage lease fixtures must have the same owner").toBe(true);
  const fullySigned = leases.data!.some(({ row_data: row }) => Boolean(
    row?.managerSignature?.name && row?.managerSignature?.signedAtIso &&
    ((row?.residentSignature?.name && row?.residentSignature?.signedAtIso) || (row?.signatureName && row?.signedAtIso)),
  ));
  expect(fullySigned, "Seeded stage prerequisite must match the case").toBe(stage === "signed");
  await page.context().clearCookies();
  // This is the documented dev/test-only seed password, not a signup proof.
  await signIn(page, fixture.email, "123Password$", "/resident/dashboard");
  await establishActivePortal(page, "resident", "/resident/dashboard");
  const phoneStatus = await page.request.get("/api/auth/phone");
  expect(phoneStatus.ok(), "Actual phone identity resolver must load").toBe(true);
  const identity = await phoneStatus.json() as { enabled?: boolean; verified?: boolean };
  if (identity.enabled) expect(identity.verified, "Actual phone resolver must accept the seeded fixture").toBe(true);
  return fixture;
}
