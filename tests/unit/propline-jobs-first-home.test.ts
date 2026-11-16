// The new landlord's "add your first home" walkthrough: pure parsing, then the state machine over an in-memory database.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type Row } from "../helpers/fake-table-db";

vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ ok: true })) }));

import { isDoneText, isLaterText, parseAvailabilityAnswer, parseHomeAddressAnswer, parseRoomsAndRentAnswer, parseRulesAnswer } from "@/lib/one-number/signup/first-home-parse";
import { FIRST_HOME_COPY, FIRST_HOME_TTL_MS, handleFirstHomeText, startFirstHomeWalkthrough } from "@/lib/one-number/signup/first-home.server";

describe("first-home answers are read by code", () => {
  it("addresses need a house number and a street word", () => {
    expect(parseHomeAddressAnswer("4709A 8th Ave NE, Seattle")).toEqual({ kind: "value", value: "4709A 8th Ave NE, Seattle" });
    expect(parseHomeAddressAnswer("my house").kind).toBe("invalid");
    expect(parseHomeAddressAnswer("https://x.test/1234").kind).toBe("invalid");
  });
  it("rooms and rent: one rent for all, or one per room", () => {
    expect(parseRoomsAndRentAnswer("3 rooms, $900 each")).toEqual({ kind: "value", value: { roomCount: 3, rentsUsd: [900] } });
    expect(parseRoomsAndRentAnswer("4 rooms $850 $900 $900 $950")).toEqual({ kind: "value", value: { roomCount: 4, rentsUsd: [850, 900, 900, 950] } });
    expect(parseRoomsAndRentAnswer("2 bedrooms 1,200")).toMatchObject({ kind: "value", value: { roomCount: 2 } });
    expect(parseRoomsAndRentAnswer("3 rooms $900 $950").kind).toBe("invalid");
    expect(parseRoomsAndRentAnswer("lots of rooms").kind).toBe("invalid");
    expect(parseRoomsAndRentAnswer("3 rooms $5").kind).toBe("invalid");
  });
  it("availability, rules and the control words", () => {
    expect(parseAvailabilityAnswer("available now")).toEqual({ kind: "value", value: "Available now" });
    expect(parseAvailabilityAnswer("Dec 1st")).toEqual({ kind: "value", value: "Available Dec 1" });
    expect(parseAvailabilityAnswer("skip")).toEqual({ kind: "skip" });
    expect(parseAvailabilityAnswer("whenever").kind).toBe("invalid");
    expect(parseRulesAnswer("no smoking, quiet after 10pm")).toMatchObject({ kind: "value" });
    expect(parseRulesAnswer("skip")).toEqual({ kind: "skip" });
    expect(isDoneText("DONE")).toBe(true);
    expect(isLaterText("later")).toBe(true);
    expect(isLaterText("4709A 8th Ave")).toBe(false);
  });
});

const PHONE = "+12065550142";
const USER = "user-landlord";
const NOW = new Date("2026-11-15T20:00:00Z");
let db: ReturnType<typeof createFakeDb>;
let sid = 0;
const photos = vi.fn(async () => ({ urls: [] as string[], mediaIds: [] as string[] }));
const deps = (over: Record<string, unknown> = {}) => ({
  now: () => NOW,
  origin: "https://proplane.ai",
  findOwners: async () => [USER],
  signInLink: async () => "https://proplane.ai/auth/confirm?token_hash=H&type=magiclink",
  adoptPhotos: photos,
  ...over,
});
const text = (body: string, over: Record<string, unknown> = {}) => handleFirstHomeText(db as never, { phoneE164: PHONE, body, messageSid: `SM${++sid}` }, deps(over) as never);
const reply = (turn: Awaited<ReturnType<typeof text>>) => (turn.handled ? turn.reply : null);

beforeEach(() => {
  sid = 0;
  photos.mockClear();
  db = createFakeDb({ sms_first_home_sessions: [], manager_property_records: [], sms_media_files: [] });
});

describe("the walkthrough", () => {
  it("runs address -> rooms -> when -> rules -> photos and ends with a DRAFT and a portal link", async () => {
    expect(await startFirstHomeWalkthrough(db as never, { phoneE164: PHONE, userId: USER, now: NOW })).toBe(FIRST_HOME_COPY.askAddress);
    expect(reply(await text("4709A 8th Ave NE, Seattle"))).toBe(FIRST_HOME_COPY.askRooms);
    expect(reply(await text("3 rooms, $900 each"))).toBe(FIRST_HOME_COPY.askAvailable);
    expect(reply(await text("Dec 1"))).toBe(FIRST_HOME_COPY.askRules);
    expect(reply(await text("no smoking, quiet after 10pm"))).toBe(FIRST_HOME_COPY.askPhotos);

    // The draft exists as soon as the essentials are known, and it is never public.
    const rec = db.tables.manager_property_records![0]!;
    expect(rec).toMatchObject({ manager_user_id: USER, status: "draft" });
    const sub = (rec.row_data as { submission: { rooms: { name: string; monthlyRent: number; availability: string }[]; houseRulesText: string } }).submission;
    expect(sub.rooms).toHaveLength(3);
    expect(sub.rooms.every((r) => r.monthlyRent === 900 && r.availability === "Available Dec 1")).toBe(true);
    expect(sub.houseRulesText).toContain("no smoking");

    photos.mockResolvedValueOnce({ urls: ["https://x.supabase.co/storage/v1/object/public/listing-photos/u/1.jpg"], mediaIds: ["m1"] });
    const done = reply(await text("DONE"))!;
    expect(done).toContain("saved as a draft with 1 photo");
    expect(done).toContain("not public yet");
    expect(done).toContain("https://proplane.ai/auth/confirm?token_hash=H");
    expect(db.tables.manager_property_records).toHaveLength(1);
    expect(db.tables.manager_property_records![0]!.status).toBe("draft");
    expect(db.tables.sms_first_home_sessions).toHaveLength(0);
  });

  it("asks again on an answer it cannot read, one question at a time", async () => {
    await startFirstHomeWalkthrough(db as never, { phoneE164: PHONE, userId: USER, now: NOW });
    expect(reply(await text("my house"))).toBe(FIRST_HOME_COPY.retryAddress);
    expect(reply(await text("12 Pine St"))).toBe(FIRST_HOME_COPY.askRooms);
    expect(reply(await text("some rooms"))).toBe(FIRST_HOME_COPY.retryRooms);
    expect(db.tables.manager_property_records).toHaveLength(0);
  });

  it("LATER ends it and keeps the account; a retried webhook changes nothing", async () => {
    await startFirstHomeWalkthrough(db as never, { phoneE164: PHONE, userId: USER, now: NOW });
    const first = await handleFirstHomeText(db as never, { phoneE164: PHONE, body: "12 Pine St", messageSid: "SMdup" }, deps() as never);
    const retry = await handleFirstHomeText(db as never, { phoneE164: PHONE, body: "12 Pine St", messageSid: "SMdup" }, deps() as never);
    expect(reply(first)).toBe(FIRST_HOME_COPY.askRooms);
    expect(reply(retry)).toBe(FIRST_HOME_COPY.askRooms);
    expect(reply(await text("later"))).toContain("https://proplane.ai/portal/properties");
    expect(db.tables.sms_first_home_sessions).toHaveLength(0);
    expect(await text("12 Pine St")).toEqual({ handled: false });
  });

  it("is not for anyone but the account's verified phone, and idles out after 48 hours", async () => {
    await startFirstHomeWalkthrough(db as never, { phoneE164: PHONE, userId: USER, now: NOW });
    expect(await text("12 Pine St", { findOwners: async () => ["someone-else"] })).toEqual({ handled: false });
    expect(await text("12 Pine St", { findOwners: async () => [] })).toEqual({ handled: false });
    expect(await text("12 Pine St", { findOwners: async () => { throw new Error("down"); } })).toEqual({ handled: false });
    expect(await text("12 Pine St", { now: () => new Date(NOW.getTime() + FIRST_HOME_TTL_MS + 1000) })).toEqual({ handled: false });
    expect(db.tables.manager_property_records).toHaveLength(0);
  });

  it("a phone with no walkthrough is never handled (a prospect or a vendor texting is not captured)", async () => {
    expect(await text("I need a room near UW, $900")).toEqual({ handled: false });
    expect(await text("any work in Ballard?")).toEqual({ handled: false });
  });

  it("never writes over a draft that was already changed in PropLane", async () => {
    await startFirstHomeWalkthrough(db as never, { phoneE164: PHONE, userId: USER, now: NOW });
    await text("12 Pine St");
    await text("2 rooms $800");
    await text("now");
    await text("skip");
    (db.tables.manager_property_records![0] as Row).status = "live";
    expect(reply(await text("DONE"))).toBe(FIRST_HOME_COPY.unavailable);
    expect(db.tables.manager_property_records![0]!.status).toBe("live");
  });
});
