import { describe, expect, it, vi } from "vitest";

import { createFakeDb, type Row } from "../helpers/fake-table-db";

vi.mock("server-only", () => ({}));

import { applyForwardedAirbnbConfirmation } from "@/lib/channel-calendar/airbnb-email-intake.server";

// SYNTHETIC forwarded confirmation: shape only.
const FORWARDED = `---------- Forwarded message ---------
From: Airbnb <automated@airbnb.com>
Subject: Reservation confirmed - Kumaran Chanthrakumar arrives Oct 3

Reservation confirmed - Kumaran Chanthrakumar arrives Oct 3

Kumaran Chanthrakumar is arriving soon.
Check-in
Sat, Oct 3
Checkout
Tue, Nov 3
Confirmation code
HMRRN4XTZ8
`;
const SUBJECT = "Fwd: Reservation confirmed - Kumaran Chanthrakumar arrives Oct 3";

const connection = (owner: string, id: string, code: string): Row => ({
  id,
  manager_user_id: owner,
  property_id: `prop-${owner}`,
  room_id: "r7",
  provider: "airbnb",
  label: null,
  import_url: "https://www.airbnb.com/calendar/ical/1.ics?s=x",
  export_token: `tok-${id}`,
  imported_ranges: [{ id: `u-${id}`, sourceUid: `u-${id}`, summary: "Reserved", start: "2026-10-03", end: "2026-11-02", reservationCode: code }],
});

function seed(extra: Record<string, Row[]> = {}) {
  return createFakeDb({
    external_calendar_connections: [connection("owner-1", "c1", "HMRRN4XTZ8"), connection("owner-2", "c2", "HMOTHER0001")],
    channel_stay_details: [],
    manager_application_records: [],
    ...extra,
  });
}

const input = { ownerUserId: "owner-1", senderUserId: "owner-1", authenticated: true, subject: SUBJECT, text: FORWARDED, receivedAt: "2026-10-01T00:00:00Z" };

describe("a forwarded Airbnb confirmation", () => {
  it("accepts a code that is one of the manager's own imported reservations and names the stay", async () => {
    const db = seed();
    const result = await applyForwardedAirbnbConfirmation(db as never, input);
    expect(result).toEqual({ applied: true, connectionId: "c1", sourceUid: "u-c1" });
    expect(db.tables.channel_stay_details).toHaveLength(1);
    expect(db.tables.channel_stay_details![0]).toMatchObject({ connection_id: "c1", source_uid: "u-c1", guest_name: "Kumaran Chanthrakumar" });
  });

  it("falls back to the first name when the mail does not spell the guest out", async () => {
    const db = seed();
    const text = "Forwarded\nAirbnb\nReservation confirmed - Kumaran arrives Oct 3\nHMRRN4XTZ8\nCheck-in Oct 3\nCheckout Nov 3";
    await applyForwardedAirbnbConfirmation(db as never, { ...input, subject: "Fwd: Reservation confirmed - Kumaran arrives Oct 3", text });
    expect(db.tables.channel_stay_details![0]).toMatchObject({ guest_name: "Kumaran" });
  });

  it("never creates or moves a stay: the name is the only thing written", async () => {
    const db = seed();
    await applyForwardedAirbnbConfirmation(db as never, input);
    const row = db.tables.channel_stay_details![0]!;
    expect(row).not.toHaveProperty("check_in");
    expect(row).not.toHaveProperty("check_out");
    expect(row).not.toHaveProperty("payout_cents");
    expect(db.tables.external_calendar_connections!.find((c) => c.id === "c1")!.imported_ranges).toEqual(connection("owner-1", "c1", "HMRRN4XTZ8").imported_ranges);
  });

  it("a name the manager typed wins", async () => {
    const db = seed({ channel_stay_details: [{ connection_id: "c1", source_uid: "u-c1", guest_name: "Kumaran C.", notes: "late" }] });
    await applyForwardedAirbnbConfirmation(db as never, input);
    expect(db.tables.channel_stay_details).toHaveLength(1);
    expect(db.tables.channel_stay_details![0]).toMatchObject({ guest_name: "Kumaran C.", notes: "late" });
  });

  it("ignores a code that is not in the manager's own calendar", async () => {
    const db = seed();
    const result = await applyForwardedAirbnbConfirmation(db as never, { ...input, text: FORWARDED.replace("HMRRN4XTZ8", "HMNOTMINE99") });
    expect(result).toEqual({ applied: false, reason: "no_match" });
    expect(db.tables.channel_stay_details).toHaveLength(0);
  });

  it("ignores a code that belongs to ANOTHER manager's calendar", async () => {
    const db = seed();
    const result = await applyForwardedAirbnbConfirmation(db as never, { ...input, text: FORWARDED.replace("HMRRN4XTZ8", "HMOTHER0001") });
    expect(result).toEqual({ applied: false, reason: "no_match" });
    expect(db.tables.channel_stay_details).toHaveLength(0);
  });

  it("believes only an authenticated owner, a booking confirmation, and a mail that is about Airbnb", async () => {
    const db = seed();
    expect(await applyForwardedAirbnbConfirmation(db as never, { ...input, authenticated: false })).toEqual({ applied: false, reason: "not_authenticated" });
    expect(await applyForwardedAirbnbConfirmation(db as never, { ...input, senderUserId: "teammate" })).toEqual({ applied: false, reason: "not_owner" });
    expect(await applyForwardedAirbnbConfirmation(db as never, { ...input, text: FORWARDED.replace(/airbnb/gi, "bnb") })).toEqual({ applied: false, reason: "not_airbnb" });
    const payout = "Airbnb\nWe've sent your payout of $412.00\nReservation HMRRN4XTZ8\nTotal payout $412.00";
    expect(await applyForwardedAirbnbConfirmation(db as never, { ...input, subject: "Fwd: payout", text: payout })).toEqual({ applied: false, reason: "not_airbnb" });
    expect(db.tables.channel_stay_details).toHaveLength(0);
  });
});
