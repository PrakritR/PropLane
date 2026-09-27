import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import type { AgentContext } from "@/lib/tools/context";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";
import { getListingDetailsTool } from "@/lib/tools/domains/leasing-sms";
import { residentSmsGetListingDetailsTool } from "@/lib/tools/domains/resident/sms-listings";

const DEV_PROJECT_REF = "emstjswhotsnyksqhqyf";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
const projectRef = (() => {
  try {
    return new URL(url).hostname.split(".")[0] ?? "";
  } catch {
    return "";
  }
})();
const enabled = process.env.RUN_SMS_LISTING_NONPROD_INTEGRATION === "1" &&
  projectRef === DEV_PROJECT_REF &&
  process.env.ALLOW_PROBE_TARGET === DEV_PROJECT_REF &&
  Boolean(serviceKey);

describe.runIf(enabled)("real dev/test SMS listing capacity", () => {
  it("returns the same stored capacity through prospect and verified-resident tools", async () => {
    const db = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: rows, error } = await db
      .from("manager_property_records")
      .select("id,manager_user_id,status,property_data,row_data")
      .in("status", ["live", "listed"])
      .limit(100);
    expect(error).toBeNull();

    const candidate = (rows ?? []).map((row) => {
      const source = (row.property_data ?? row.row_data) as Record<string, unknown> | null;
      const raw = source?.listingSubmission;
      if (!raw || typeof raw !== "object") return null;
      try {
        const submission = normalizeManagerListingSubmissionV1(raw as never);
        return submission.rooms.some((room) => room.occupancyCapacity > 1)
          ? { row, submission }
          : null;
      } catch {
        return null;
      }
    }).find(Boolean);
    expect(candidate).toBeTruthy();
    if (!candidate) return;

    const owner = String(candidate.row.manager_user_id);
    const prospectCtx = {
      landlordId: owner,
      userId: owner,
      email: "",
      roles: ["leasing_sms_agent"],
      isAdmin: false,
      db,
      listingPublicOnly: true,
    } as AgentContext;
    const residentCtx = {
      kind: "resident",
      userId: "nonprod-capacity-probe",
      email: "nonprod-capacity-probe@example.invalid",
      managerIds: [owner],
      activeManagerId: owner,
      landlordId: "nonprod-capacity-probe",
      channel: "sms",
      phase: "application",
      managerTier: null,
      db,
    } as ResidentAgentContext;

    const prospect = await getListingDetailsTool.handler(prospectCtx, { propertyId: String(candidate.row.id) });
    const resident = await residentSmsGetListingDetailsTool.handler(residentCtx, { propertyId: String(candidate.row.id) });
    expect(prospect).toEqual(resident);
    expect(prospect).toMatchObject({ found: true });
    if (!prospect.found) return;

    const expectedMaximum = candidate.submission.rooms.reduce(
      (total, room) => total + room.occupancyCapacity,
      0,
    );
    expect(prospect.listing.rooms.some((room) => room.residentCapacity > 1)).toBe(true);
    expect(prospect.listing.maximumResidents).toBe(expectedMaximum);
    console.info("sms-listing-nonprod-evidence", {
      projectRef,
      listingId: candidate.row.id,
      prospectTool: getListingDetailsTool.name,
      residentTool: residentSmsGetListingDetailsTool.name,
      roomCount: prospect.listing.allRoomCount,
      maximumResidents: prospect.listing.maximumResidents,
      capacities: prospect.listing.rooms.map((room) => room.residentCapacity),
    });
  }, 30_000);
});
