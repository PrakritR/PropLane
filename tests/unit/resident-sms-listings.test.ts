import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { buildResidentRegistry } from "@/lib/tools/resident-index";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";
import {
  residentSmsGetListingDetailsTool,
  residentSmsGetListingLinkTool,
  residentSmsListLiveListingsTool,
} from "@/lib/tools/domains/resident/sms-listings";
import { RESIDENT_SMS_AGENT_SYSTEM_PROMPT, LEASING_SMS_AGENT_SYSTEM_PROMPT } from "@/lib/agent/system-prompts";
import { runAgentTurn } from "@/lib/agent/loop";
import { __resetLeasingCatalogCache, __resetSmsOccupancyCache } from "@/lib/tools/domains/leasing-sms";

const provider = vi.hoisted(() => ({ complete: vi.fn() }));
const occupancy = vi.hoisted(() => ({ load: vi.fn() }));
const publicCatalog = vi.hoisted(() => ({ rows: [{ id: "home-1" }] as Array<Record<string, unknown> & { id: string }> }));
vi.mock("@/lib/public-listings.server", () => ({ getPublicListings: async () => publicCatalog.rows }));
vi.mock("@/lib/public-room-occupancy.server", () => ({ loadPublicRoomOccupancy: occupancy.load }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/agent/provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/provider")>()),
  completeAgentModel: provider.complete,
}));

function context(options: { rooms?: Record<string, unknown>[]; rowData?: unknown; status?: string; assistantInfo?: string } = {}) {
  const row = {
    id: "home-1",
    status: options.status ?? "live",
    property_data: {
      title: "Cedar House",
      address: "1 Cedar St",
      available: "Unavailable",
      listingSubmission: {
        ...createDefaultListingSubmission(),
        ...(options.assistantInfo ? { aiCommunicationInfo: { rules: options.assistantInfo } } : {}),
        rooms: options.rooms ?? [
          { id: "room-a", name: "Room A", monthlyRent: 800, availability: "Available now", furnishing: "Furnished", roomAmenitiesText: "Desk and closet" },
          { id: "room-b", name: "Room B", monthlyRent: 850, availability: "Unavailable (occupied)", furnishing: "" },
        ],
      },
    },
    row_data: options.rowData ?? null,
  };
  publicCatalog.rows = [{ id: row.id, ...row.property_data }];
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const q: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "order", "limit"]) {
    q[method] = (...args: unknown[]) => { calls.push({ method, args }); return q; };
  }
  q.maybeSingle = async () => ({ data: row, error: null });
  q.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [row], error: null }).then(resolve);
  const ctx = {
    kind: "resident", userId: "resident-1", email: "resident@example.com",
    managerIds: ["manager-1"], activeManagerId: "manager-1",
    landlordId: "resident-1", channel: "sms", phase: "application", managerTier: null,
    db: { from: vi.fn(() => q) },
  } as unknown as ResidentAgentContext;
  return { ctx, calls };
}

describe("resident SMS public listing facts", () => {
  beforeEach(() => {
    publicCatalog.rows = [{ id: "home-1" }];
    __resetLeasingCatalogCache();
    __resetSmsOccupancyCache();
  });

  it("does not disclose a listed or excluded manager record through any public listing tool", async () => {
    const { ctx } = context({ status: "listed" });
    publicCatalog.rows = [];
    expect((await residentSmsListLiveListingsTool.handler(ctx, { query: "Cedar" })).listings).toEqual([]);
    expect((await residentSmsGetListingDetailsTool.handler(ctx, { propertyId: "home-1" })).found).toBe(false);
    expect(await residentSmsGetListingLinkTool.handler(ctx, { propertyId: "home-1" })).toMatchObject({ ok: false });
  });

  it("reads projected public copy rather than private assistant notes", async () => {
    const { ctx } = context({ assistantInfo: "Private manager instructions" });
    const projected = publicCatalog.rows[0] as Record<string, unknown>;
    publicCatalog.rows = [{ ...projected, listingSubmission: {
      ...(projected.listingSubmission as Record<string, unknown>),
      aiCommunicationInfo: undefined,
    } }];
    const details = await residentSmsGetListingDetailsTool.handler(ctx, { propertyId: "home-1" });
    expect(details.listing?.assistantInfo).toBeNull();
    expect(details.listing?.rooms[0]).toMatchObject({ furnishing: "Furnished" });
  });
  it("uses the same public room spans for blank saved availability and verifies the manager scope", async () => {
    occupancy.load.mockResolvedValueOnce([
      { roomChoice: "home-1::room-a", spans: [] },
      { roomChoice: "home-1::room-b", spans: [{ start: "2020-01-01", end: null, count: 1 }] },
    ]);
    const { ctx } = context({ rooms: [
      { id: "room-a", name: "Room A", monthlyRent: 800, availability: "", furnishing: "Furnished" },
      { id: "room-b", name: "Room B", monthlyRent: 850, availability: "Now" },
    ] });
    const detail = await residentSmsGetListingDetailsTool.handler(ctx, { propertyId: "home-1" });
    expect(detail.listing?.rooms).toEqual([
      expect.objectContaining({ name: "Room A", publishedAvailability: null, currentAvailability: "Available now", currentAvailabilityVerified: true, furnishing: "Furnished" }),
      expect.objectContaining({ name: "Room B", currentAvailability: "Unavailable (occupied)", currentAvailabilityVerified: true }),
    ]);
    expect(occupancy.load).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining([expect.objectContaining({ id: "home-1" })]), "manager-1");
  });

  it("leaves current availability unknown when the occupancy read fails", async () => {
    occupancy.load.mockRejectedValueOnce(new Error("offline"));
    const { ctx } = context();
    const detail = await residentSmsGetListingDetailsTool.handler(ctx, { propertyId: "home-1" });
    expect(detail.listing?.rooms[0]).toMatchObject({ publishedAvailability: "Available now", currentAvailability: null, currentAvailabilityVerified: false });
  });
  it("authorizes a listing link without an occupancy read", async () => {
    occupancy.load.mockClear();
    const { ctx } = context();
    const link = await residentSmsGetListingLinkTool.handler(ctx, { propertyId: "home-1" });
    expect(link).toMatchObject({ ok: true, listingUrl: expect.stringContaining("home-1") });
    expect(occupancy.load).not.toHaveBeenCalled();
  });
  it("has the listing reads in application phase SMS only", () => {
    const { ctx } = context();
    expect(buildResidentRegistry(ctx).has("get_listing_details")).toBe(true);
    expect(buildResidentRegistry({ ...ctx, channel: "portal" }).has("get_listing_details")).toBe(false);
  });

  it("returns distinct room availability and furnishing without the conflicting home summary", async () => {
    const { ctx, calls } = context();
    const listed = await residentSmsListLiveListingsTool.handler(ctx, { query: "Cedar" });
    expect(listed.listings[0]).not.toHaveProperty("available");
    const detail = await residentSmsGetListingDetailsTool.handler(ctx, { propertyId: "home-1" });
    expect(detail.listing).not.toHaveProperty("available");
    expect(detail.listing?.rooms).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Room A", publishedAvailability: "Available now", currentAvailabilityVerified: false, furnishing: "Furnished", roomAmenities: "Desk and closet" }),
      expect.objectContaining({ name: "Room B", publishedAvailability: "Unavailable (occupied)", currentAvailabilityVerified: false, furnishing: null }),
    ]));
    expect(calls).toContainEqual({ method: "eq", args: ["manager_user_id", "manager-1"] });
    expect(calls).toContainEqual({ method: "in", args: ["status", ["live", "listed"]] });
    const link = await residentSmsGetListingLinkTool.handler(ctx, { propertyId: "home-1" });
    expect(link).toMatchObject({ ok: true, listingUrl: expect.stringContaining("home-1") });
  });

  it("does not present a stale published opening as verified current availability", async () => {
    const { ctx } = context({
      rowData: { approvedStayAfterPublication: { roomId: "room-a", status: "approved" } },
    });
    const listed = await residentSmsListLiveListingsTool.handler(ctx, { query: "Cedar" });
    const detail = await residentSmsGetListingDetailsTool.handler(ctx, { propertyId: "home-1" });
    const summaryRoom = listed.listings[0]?.rooms.find((room) => room.id === "room-a");
    const detailRoom = detail.listing?.rooms.find((room) => room.id === "room-a");
    for (const room of [summaryRoom, detailRoom]) {
      expect(room).toMatchObject({ publishedAvailability: "Available now", currentAvailabilityVerified: false });
      expect(room).not.toHaveProperty("availability");
    }
  });

  it("keeps every room when one legacy detail is malformed", async () => {
    const { ctx } = context({ rooms: [
      { id: "bad-detail", name: "North Room", monthlyRent: 800, availability: "Available now", furnishing: "Furnished", detail: 42 },
      { id: "good-detail", name: "South Room", monthlyRent: 850, availability: "Available from October", furnishing: "Unfurnished", detail: "Corner room" },
    ] });
    const listed = await residentSmsListLiveListingsTool.handler(ctx, { query: "Cedar" });
    const detail = await residentSmsGetListingDetailsTool.handler(ctx, { propertyId: "home-1" });
    expect(listed.listings[0]?.rooms).toHaveLength(2);
    expect(detail.listing?.rooms).toEqual([
      expect.objectContaining({ id: "bad-detail", detail: null, publishedAvailability: "Available now", furnishing: "Furnished" }),
      expect.objectContaining({ id: "good-detail", detail: "Corner room", publishedAvailability: "Available from October", furnishing: "Unfurnished" }),
    ]);
  });

  it("requires the verified SMS manager binding before every read", async () => {
    const { ctx } = context();
    await expect(residentSmsGetListingDetailsTool.handler({ ...ctx, activeManagerId: "manager-2" }, { propertyId: "home-1" }))
      .rejects.toThrow("unavailable");
    await expect(residentSmsGetListingLinkTool.handler({ ...ctx, channel: "portal" }, { propertyId: "home-1" }))
      .rejects.toThrow("unavailable");
  });

  it("grounds both SMS prompts in the named room and avoids needless escalation", () => {
    expect(RESIDENT_SMS_AGENT_SYSTEM_PROMPT).toContain("currentAvailabilityVerified");
    expect(RESIDENT_SMS_AGENT_SYSTEM_PROMPT).toContain("publishedAvailability");
    expect(RESIDENT_SMS_AGENT_SYSTEM_PROMPT).toContain("never an aggregate home label");
    expect(LEASING_SMS_AGENT_SYSTEM_PROMPT).toContain("currentAvailabilityVerified");
    expect(LEASING_SMS_AGENT_SYSTEM_PROMPT).toContain("publishedAvailability");
    expect(LEASING_SMS_AGENT_SYSTEM_PROMPT).toContain("Do not escalate a question the room facts answer");
  });

  it("delivers room availability and furnishing tool results to a Luna model call", async () => {
    const { ctx } = context();
    const responses = [
      { content: [{ type: "tool_use", id: "list-1", name: "list_live_listings", input: { query: "Cedar" } }], stopReason: "tool_use" },
      { content: [{ type: "tool_use", id: "detail-1", name: "get_listing_details", input: { propertyId: "home-1", roomQuery: "Room A" } }], stopReason: "tool_use" },
      { content: [{ type: "text", text: "The listing shows Room A as available now and furnished." }], stopReason: "end_turn" },
    ];
    provider.complete.mockReset();
    provider.complete.mockImplementation(async () => ({
      ...responses.shift()!,
      usage: { inputTokens: 10, outputTokens: 10 },
      provider: "openai",
      latencyMs: 1,
    }));

    const result = await runAgentTurn({
      ctx,
      registry: buildResidentRegistry(ctx),
      system: RESIDENT_SMS_AGENT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: "Is Room A at Cedar House available and furnished?" }],
      model: { model: "gpt-6-luna", tier: "standard", provider: "openai", route: "luna_primary" },
    });

    expect(result.reply).toContain("Room A as available now and furnished");
    expect(provider.complete).toHaveBeenCalledTimes(3);
    const firstCall = provider.complete.mock.calls[0]![0];
    const finalCall = provider.complete.mock.calls[2]![0];
    expect(firstCall.selection).toMatchObject({ model: "gpt-6-luna", provider: "openai", route: "luna_primary" });
    expect(firstCall.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(["list_live_listings", "get_listing_details"]));
    const results = finalCall.messages
      .flatMap((message: { content: unknown }) => Array.isArray(message.content) ? message.content : [])
      .filter((block: { type: string }) => block.type === "tool_result")
      .map((block: { content: string }) => JSON.parse(block.content) as Record<string, unknown>);
    expect(results[1]).toMatchObject({
      listing: {
        rooms: [{
          name: "Room A",
          publishedAvailability: "Available now",
          furnishing: "Furnished",
          roomAmenities: "Desk and closet",
          currentAvailabilityVerified: false,
        }],
      },
    });
  });
});
