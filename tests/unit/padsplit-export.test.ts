import { beforeEach, describe, expect, it, vi } from "vitest";

// PadSplit has no calendar feed or API: a stay typed in with Source "PadSplit" is an ordinary PropLane booking,
// so it must reach the Airbnb AND Booking.com export feeds like any other (that is the whole point of entering it).
const state = vi.hoisted(() => ({
  provider: "airbnb" as string,
  blocks: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const verb of ["select", "eq", "in", "or", "like", "order", "range", "limit"]) chain[verb] = () => chain;
      chain.then = (resolve: (value: unknown) => void) =>
        resolve({ data: table === "portal_schedule_records" ? state.blocks : [], error: null });
      return chain;
    },
  }),
}));
vi.mock("@/lib/channel-calendar/sync.server", () => ({
  loadConnectionByExportToken: async () => ({ id: "c-export", property_id: "p", room_id: "r", provider: state.provider, manager_user_id: "m", export_token: "token" }),
  loadPropertyRecord: async () => ({ property: null }),
}));
import { GET } from "@/app/api/calendar/export/[token]/route";

const request = () => GET(new Request("https://example.com/api/calendar/export/token.ics"), { params: Promise.resolve({ token: "token.ics" }) });
const padsplit = (over: Record<string, unknown> = {}) => ({
  row_data: { roomId: "r", checkIn: "2026-11-10", checkOut: "2026-11-24", residentName: "Jordan", bookingStatus: "confirmed", stayDetails: { source: "PadSplit" }, ...over },
});

beforeEach(() => {
  state.provider = "airbnb";
  state.blocks = [];
});

describe("a PadSplit stay blocks the other channels", () => {
  it.each(["airbnb", "booking_com"])("appears in the %s export feed, check-out exclusive", async (provider) => {
    state.provider = provider;
    state.blocks = [padsplit()];
    const body = await (await request()).text();
    expect(body).toContain("DTSTART;VALUE=DATE:20261110");
    expect(body).toContain("DTEND;VALUE=DATE:20261124");
  });

  it("a cancelled PadSplit stay frees the nights again", async () => {
    state.blocks = [padsplit({ bookingStatus: "cancelled" })];
    expect(await (await request()).text()).not.toContain("20261110");
  });

  it("a PadSplit stay in another room does not block this one", async () => {
    state.blocks = [padsplit({ roomId: "elsewhere" })];
    expect(await (await request()).text()).not.toContain("20261110");
  });
});
