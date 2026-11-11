import { describe, expect, it, vi } from "vitest";
import {
  fanOutHouseSend,
  houseLackLine,
  houseResidentsFromStays,
  housePersonResultLine,
  houseSendCounts,
  houseSendPayload,
  personResultFromResponse,
  tallyHouseChannels,
  type HousePersonResult,
  type HouseRecipient,
  type HouseStayLike,
} from "@/lib/house-message-recipients";

const TODAY = "2026-11-10";
const longStay = (email: string, name: string, room: string, extra: Partial<HouseStayLike["resident"]> = {}): HouseStayLike => ({
  propertyId: "p1",
  roomLabel: room,
  start: "2026-01-01",
  end: "2027-01-01",
  resident: { source: "proplane", residentEmail: email, residentName: name, ...extra },
});
const guestStay = (email: string, room: string, extra: Partial<HouseStayLike["resident"]> = {}): HouseStayLike => ({
  propertyId: "p1",
  roomLabel: room,
  start: "2026-11-08",
  end: "2026-11-12",
  resident: { source: "hold", residentEmail: email, residentName: "Airbnb guest", ...extra },
});

const derive = (stays: HouseStayLike[], includeGuests = false, over: Partial<Parameters<typeof houseResidentsFromStays>[1]> = {}) =>
  houseResidentsFromStays(stays, {
    propertyId: "p1",
    today: TODAY,
    includeGuests,
    profilesByEmail: new Map(),
    optedOutEmails: new Set(),
    reachByEmail: new Map(),
    normalizePhone: (raw) => (raw && raw.replace(/\D/g, "").length >= 10 ? raw : null),
    ...over,
  });

describe("who lives in the house", () => {
  const stays = [
    longStay("ann@example.com", "Ann", "Room 1", { residentPhone: "2065550101" }),
    longStay("ben@import.proplane.local", "Ben", "Room 2"),
    guestStay("guest@example.com", "Room 3", { residentPhone: "2065550102" }),
    guestStay("ical@example.com", "Room 4", { icalConnectionId: "c1" }),
    { ...longStay("other@example.com", "Other", "Room 9"), propertyId: "p2" },
    { ...longStay("past@example.com", "Past", "Room 8"), end: "2026-10-01" },
  ];

  it("excludes short-stay guests, other houses and ended stays by default", () => {
    const { people, excludedGuests } = derive(stays);
    expect(people.map((person) => person.name)).toEqual(["Ann", "Ben"]);
    expect(excludedGuests).toBe(2);
  });

  it("includes guests only when asked", () => {
    const { people } = derive(stays, true);
    expect(people).toHaveLength(4);
    expect(people.filter((person) => person.guest)).toHaveLength(2);
  });

  it("lists a person once even with two stays, preferring the long-term one", () => {
    const { people } = derive([guestStay("ann@example.com", "Room 5"), longStay("ann@example.com", "Ann", "Room 1")], true);
    expect(people).toHaveLength(1);
    expect(people[0]!.guest).toBe(false);
  });

  it("derives channels: app always, email only if real, text only with a phone and no STOP", () => {
    const { people } = derive(stays, false, { optedOutEmails: new Set(["ann@example.com"]) });
    const ann = people.find((person) => person.name === "Ann")!;
    const ben = people.find((person) => person.name === "Ben")!;
    expect(ann.channels).toEqual({ app: true, email: true, sms: false });
    expect(ben.channels).toEqual({ app: true, email: false, sms: false });
  });

  it("narrows by the person's own Reach by", () => {
    const { people } = derive([longStay("ann@example.com", "Ann", "Room 1", { residentPhone: "2065550101" })], false, {
      reachByEmail: new Map([["ann@example.com", ["app", "sms"]]]),
    });
    expect(people[0]!.channels).toEqual({ app: true, email: false, sms: true });
  });

  it("counts a stay with no address as unaddressable, never invents one", () => {
    const { people, unaddressable } = derive([longStay("", "Nobody", "Room 7")]);
    expect(people).toEqual([]);
    expect(unaddressable).toBe(1);
  });
});

const person = (id: string, channels: Partial<HouseRecipient["channels"]> = {}): HouseRecipient => ({
  id,
  name: id.toUpperCase(),
  roomLabel: `Room ${id}`,
  email: `${id}@example.com`,
  userId: null,
  guest: false,
  channels: { app: true, email: true, sms: true, ...channels },
});

describe("channel tally", () => {
  const people = [person("a"), person("b", { sms: false }), person("c", { sms: false }), person("d", { sms: false, email: false }), person("e")];

  it("counts reached of total per picked channel; app always reaches everyone", () => {
    const tally = tallyHouseChannels(people, { app: true, email: true, sms: true });
    expect(tally.sms).toEqual({ reached: 2, total: 5 });
    expect(tally.email).toEqual({ reached: 4, total: 5 });
    expect(tally.app).toEqual({ reached: 5, total: 5 });
    expect(tally.missingPhone.map((p) => p.id)).toEqual(["b", "c", "d"]);
    expect(tally.missingEmail.map((p) => p.id)).toEqual(["d"]);
    expect(houseLackLine(tally)).toBe("3 have no phone, 1 has no real email");
  });

  it("omits a channel that is not picked, and the amber line says nothing when all are reachable", () => {
    const tally = tallyHouseChannels([person("a"), person("b")], { app: true, email: false, sms: false });
    expect(tally.sms).toBeNull();
    expect(tally.email).toBeNull();
    expect(houseLackLine(tally)).toBe("");
  });
});

describe("fan-out", () => {
  it("sends exactly once per person, at most 3 at a time, in input order", async () => {
    const people = ["a", "b", "c", "d", "e", "f", "g"].map((id) => person(id));
    let inFlight = 0;
    let peak = 0;
    const calls: string[] = [];
    const results = await fanOutHouseSend(people, async (p) => {
      calls.push(p.id);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return personResultFromResponse(p, { app: true, email: true, sms: false }, { ok: true, data: { ok: true } });
    });
    expect(calls.sort()).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    expect(peak).toBeLessThanOrEqual(3);
    expect(results.map((r) => r.id)).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });

  it("records a throw or a refusal as that person's failure and keeps going", async () => {
    const send = vi.fn(async (p: HouseRecipient): Promise<HousePersonResult> => {
      if (p.id === "b") throw new Error("boom");
      return personResultFromResponse(p, { app: true, email: false, sms: false }, p.id === "c" ? { ok: false, data: { error: "Forbidden." } } : { ok: true, data: { ok: true } });
    });
    const results = await fanOutHouseSend([person("a"), person("b"), person("c")], send);
    expect(send).toHaveBeenCalledTimes(3);
    expect(results.map((r) => r.ok)).toEqual([true, false, false]);
    expect(results[2]!.error).toBe("Forbidden.");
    expect(houseSendCounts(results)).toMatchObject({ recipients: 3, sent: 1, failed: 2 });
  });
});

describe("per-person send", () => {
  it("addresses one person, always lands in the app, and only asks for channels they can receive", () => {
    const payload = houseSendPayload(person("b", { sms: false }), {
      subject: "Water off",
      text: "Thursday 10-1",
      via: { app: true, email: true, sms: true },
      senderName: "Pat",
      sendId: "11111111-1111-4111-8111-111111111111",
    });
    expect(payload).toMatchObject({
      toEmails: ["b@example.com"],
      deliverToPortalInbox: true,
      deliverViaEmail: true,
      deliverViaSms: false,
      eventCategory: "messages",
    });
    expect(payload).not.toHaveProperty("propertyId");
    expect(payload).not.toHaveProperty("toBroadcast");
  });

  it("reads per-channel deliveries when the route returns them", () => {
    const result = personResultFromResponse(
      person("a"),
      { app: true, email: true, sms: true },
      {
        ok: true,
        data: {
          ok: true,
          deliveries: [
            { channel: "sms", status: "delivered", at: "t" },
            { channel: "email", status: "failed", error: "Not a real mailbox", at: "t" },
          ],
        },
      },
    );
    expect(result).toMatchObject({ ok: true, sms: "delivered", email: "failed", emailError: "Not a real mailbox" });
    expect(housePersonResultLine(result)).toBe("App ✓ · Text Delivered · Email Not delivered");
  });

  it("reads Sent for a wanted channel with no deliveries, and Skipped for one they cannot receive", () => {
    const result = personResultFromResponse(person("b", { sms: false }), { app: true, email: true, sms: true }, { ok: true, data: { ok: true } });
    expect(result).toMatchObject({ email: "sent", sms: "skipped" });
  });
});
