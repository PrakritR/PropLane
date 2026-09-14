import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyHouseInfo, setHouseInfoValue, type HouseInfoV1 } from "@/lib/house-info";
import { getMoveInInfoTool } from "@/lib/tools/domains/resident/lease";
import { makeResidentToolCtx } from "./tools/fake-resident-ctx";

const APPLICANT = "applicant@example.com";
const MANAGER_A = "manager-a";

const { serviceClient, loadMoveIn, leaseSigned, attestedTenancy, buildText, buildHtml } = vi.hoisted(() => ({
  serviceClient: vi.fn(),
  loadMoveIn: vi.fn(),
  leaseSigned: vi.fn(),
  attestedTenancy: vi.fn(),
  buildText: vi.fn(() => "reminder text"),
  buildHtml: vi.fn(() => "<p>reminder</p>"),
}));

vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: serviceClient }));
vi.mock("@/lib/resident-move-in-info", () => ({ loadResidentMoveInForEmail: loadMoveIn }));
vi.mock("@/lib/resident-portal-access", () => ({
  loadResidentLeaseSignedStatus: leaseSigned,
  loadResidentManagerAttestedTenancy: attestedTenancy,
}));
vi.mock("@/lib/move-in-reminder-email", () => ({
  MOVE_IN_REMINDER_SUBJECT: "Your move-in is tomorrow",
  buildMoveInReminderText: buildText,
  buildMoveInReminderHtml: buildHtml,
}));
vi.mock("@/lib/resident-outbound-sms.server", () => ({
  canSendResidentOutboundSms: () => false,
  sendResidentOutboundSms: vi.fn(),
}));
vi.mock("@/lib/push-notifications.server", () => ({ sendPushToUser: vi.fn() }));

function tomorrowUtc(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function houseInfoWithCodes(): HouseInfoV1 {
  let info = setHouseInfoValue(emptyHouseInfo(), "access", "doorCode", "001000");
  info = setHouseInfoValue(info, "wifi", "network", "4709A");
  info = setHouseInfoValue(info, "wifi", "password", "4709A4709A$$");
  return info;
}

/** Only the tables this cron touches, in the shapes it reads them in. */
function fakeDb() {
  const applicationRows = [
    {
      resident_email: APPLICANT,
      manager_user_id: MANAGER_A,
      row_data: { id: "APP-1", bucket: "approved", name: "Alex Applicant", manualResidentDetails: { moveInDate: tomorrowUtc() } },
    },
  ];
  return {
    from(table: string) {
      if (table === "manager_application_records") {
        return { select: () => Promise.resolve({ data: applicationRows, error: null }) };
      }
      if (table === "portal_outbound_mail_records") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
          upsert: async () => ({ data: null, error: null }),
        };
      }
      if (table === "portal_inbox_thread_records") {
        return { upsert: async () => ({ data: null, error: null }) };
      }
      if (table === "profiles") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) };
      }
      throw new Error(`Unexpected table ${table}`);
    },
  };
}

async function runCron() {
  const { GET } = await import("@/app/api/cron/send-move-in-reminders/route");
  return GET(
    new Request("https://prop-lane.space/api/cron/send-move-in-reminders", {
      headers: { authorization: "Bearer cron-secret" },
    }),
  );
}

describe("move-in reminder withholds house access until the lease is signed", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("CRON_SECRET", "cron-secret");
    vi.stubEnv("RESEND_API_KEY", "");
    serviceClient.mockImplementation(() => fakeDb());
    loadMoveIn.mockResolvedValue({
      propertyLabel: "4709A 8th Ave NE",
      addressLine: "4709A 8th Ave NE, Seattle, WA",
      instructions: "Park on the street.",
      generalHouseInfo: "Bins go out Tuesday.",
      houseInfo: houseInfoWithCodes(),
    });
    leaseSigned.mockResolvedValue(false);
    attestedTenancy.mockResolvedValue(false);
  });

  it("sends an approved-but-unsigned applicant no door, gate or Wi-Fi codes", async () => {
    const response = await runCron();
    expect(response.status).toBe(200);

    const params = buildText.mock.calls[0]![0] as { houseInfo: unknown; generalHouseInfo: unknown };
    expect(params.houseInfo).toBeNull();
    // Free text is the manager's own note, not the withheld access fields.
    expect(params.generalHouseInfo).toBe("Bins go out Tuesday.");
    expect((buildHtml.mock.calls[0]![0] as { houseInfo: unknown }).houseInfo).toBeNull();
  });

  it("sends the codes once the lease is signed", async () => {
    leaseSigned.mockResolvedValue(true);
    await runCron();
    const params = buildText.mock.calls[0]![0] as { houseInfo: HouseInfoV1 | null };
    expect(params.houseInfo?.access.doorCode).toBe("001000");
  });

  it("sends the codes to a manager-attested off-platform tenant", async () => {
    attestedTenancy.mockResolvedValue(true);
    await runCron();
    expect((buildText.mock.calls[0]![0] as { houseInfo: HouseInfoV1 | null }).houseInfo).not.toBeNull();
  });

  it("withholds the codes when the lease lookup fails", async () => {
    leaseSigned.mockRejectedValue(new Error("lease lookup down"));
    const response = await runCron();
    expect(response.status).toBe(200);
    expect((buildText.mock.calls[0]![0] as { houseInfo: unknown }).houseInfo).toBeNull();
  });

  it("resolves the move-in scoped to the manager who approved it", async () => {
    await runCron();
    // Unscoped, an applicant approved by two managers is ranked across both and
    // can be mailed the other manager's property and codes.
    expect(loadMoveIn).toHaveBeenCalledWith(APPLICANT, { managerUserId: MANAGER_A });
    expect(leaseSigned).toHaveBeenCalledWith(APPLICANT, MANAGER_A);
  });
});

describe("get_move_in_info withholds house access until the lease is signed", () => {
  function seed() {
    return {
      manager_application_records: [
        {
          id: "APP-1",
          resident_email: "resa@axis.test",
          manager_user_id: "manager_1",
          updated_at: "2026-06-01T00:00:00.000Z",
          row_data: {
            id: "APP-1",
            bucket: "approved",
            email: "resa@axis.test",
            propertyId: "prop_1",
            assignedPropertyId: "prop_1",
            property: "4709A 8th Ave NE",
            application: { propertyId: "prop_1", leaseStart: "2026-07-01" },
          },
        },
      ],
      manager_property_records: [
        {
          id: "prop_1",
          manager_user_id: "manager_1",
          row_data: null,
          property_data: {
            id: "prop_1",
            title: "4709A 8th Ave NE",
            buildingName: "4709A 8th Ave NE",
            address: "4709A 8th Ave NE, Seattle, WA",
            listingSubmission: {
              v: 1,
              buildingName: "4709A 8th Ave NE",
              address: "4709A 8th Ave NE, Seattle, WA",
              zip: "98115",
              houseRulesText: "",
              rooms: [],
              bathrooms: [],
              sharedSpaces: [],
              quickFacts: [],
              bundles: [],
              housePhotoDataUrls: [],
              houseInfo: houseInfoWithCodes(),
            },
          },
        },
      ],
    };
  }

  it("returns no house details or Wi-Fi password in the application phase", async () => {
    const { ctx } = makeResidentToolCtx(seed(), { phase: "application" });
    const res = (await getMoveInInfoTool.handler(ctx, {})) as {
      moveIn: { houseDetails: unknown[]; wifiPassword: string | null; addressLine: string };
    };
    expect(res.moveIn.houseDetails).toEqual([]);
    expect(res.moveIn.wifiPassword).toBeNull();
    expect(JSON.stringify(res)).not.toContain("001000");
    // The address and the property are not the secret — only what opens the door is.
    expect(res.moveIn.addressLine).toContain("4709A 8th Ave NE");
  });

  it("returns them once the lease unlocks the workspace", async () => {
    const { ctx } = makeResidentToolCtx(seed(), { phase: "approved" });
    const res = (await getMoveInInfoTool.handler(ctx, {})) as {
      moveIn: { houseDetails: unknown[]; wifiPassword: string | null };
    };
    expect(res.moveIn.houseDetails.length).toBeGreaterThan(0);
    expect(res.moveIn.wifiPassword).toBe("4709A4709A$$");
    expect(JSON.stringify(res)).toContain("001000");
  });
});
