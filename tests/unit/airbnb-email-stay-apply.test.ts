import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fakeSupabaseClient, type Row } from "./helpers/fake-supabase-tables";

vi.mock("server-only", () => ({}));

import { applyAirbnbEmailToStay } from "@/lib/channel-calendar/airbnb-email-intake.server";

describe("applyAirbnbEmailToStay", () => {
  let tables: Record<string, Row[]>;
  const range = { id: "uid-1", sourceUid: "uid-1", summary: "Reserved", start: "2026-10-13", end: "2026-10-16", reservationCode: "HMHW5SHXRB" };
  const connection = (id: string, owner: string): Row => ({
    id, manager_user_id: owner, property_id: "p1", room_id: "r1", provider: "airbnb", label: "Room 9", import_url: "https://x", export_token: "t",
    imported_ranges: [range], last_synced_at: null, last_error: null, export_last_fetched_at: null,
  });
  beforeEach(() => {
    tables = { external_calendar_connections: [connection("c-mine", "mgr-1"), connection("c-theirs", "mgr-2")], channel_stay_details: [] };
  });

  it("matches by code on the owner's own connections and writes the payout once", async () => {
    const client = fakeSupabaseClient(tables) as unknown as SupabaseClient;
    const facts = { kind: "payout" as const, confirmationCode: "HMHW5SHXRB", guestFirstName: "Juan", payoutCents: 41200, checkIn: "2026-10-13", checkOut: "2026-10-16" };
    const first = await applyAirbnbEmailToStay(client, "mgr-1", facts, "2026-10-17T09:00:00.000Z");
    expect(first).toEqual({ applied: true, connectionId: "c-mine", sourceUid: "uid-1" });
    await applyAirbnbEmailToStay(client, "mgr-1", facts, "2026-10-17T09:00:00.000Z");
    expect(tables.channel_stay_details).toHaveLength(1);
    expect(tables.channel_stay_details[0]).toMatchObject({
      connection_id: "c-mine", guest_name: "Juan", payout_cents: 41200, paid_at: "2026-10-17T09:00:00.000Z", source: "airbnb_email", check_in: "2026-10-13",
    });
  });

  it("keeps a name the manager typed, and never touches another manager's stay", async () => {
    tables.channel_stay_details.push({ connection_id: "c-mine", source_uid: "uid-1", guest_name: "Juan Angel", notes: null });
    const client = fakeSupabaseClient(tables) as unknown as SupabaseClient;
    await applyAirbnbEmailToStay(client, "mgr-1", { kind: "booking", confirmationCode: "HMHW5SHXRB", guestFirstName: "Juan" }, "2026-10-09T00:00:00.000Z");
    expect(tables.channel_stay_details.find((r) => r.connection_id === "c-mine")?.guest_name).toBe("Juan Angel");
    expect(tables.channel_stay_details.some((r) => r.connection_id === "c-theirs")).toBe(false);
    const none = await applyAirbnbEmailToStay(client, "mgr-3", { kind: "booking", confirmationCode: "HMHW5SHXRB", guestFirstName: "Juan" }, "2026-10-09T00:00:00.000Z");
    expect(none).toEqual({ applied: false, reason: "no_match" });
  });
});
