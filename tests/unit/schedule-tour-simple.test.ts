import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyAddPersonForm, type AddPersonForm } from "@/components/portal/resident-wizard/state";
import {
  buildScheduleTourSimpleForm,
  tourSlotsForManager,
  fetchOpenTourSlotsForProperty,
  openSlotKeysForDate,
  openTourDates,
  slotKeyDateStr,
  slotKeyIndex,
  slotKeyToTourFields,
} from "@/lib/schedule-tour-simple";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("slot key parsing", () => {
  it("splits date and index", () => {
    expect(slotKeyDateStr("2026-08-06:18")).toBe("2026-08-06");
    expect(slotKeyIndex("2026-08-06:18")).toBe(18);
  });

  it("converts a slot key to 24h tourDate/tourStart", () => {
    expect(slotKeyToTourFields("2026-08-06:18")).toEqual({ tourDate: "2026-08-06", tourStart: "09:00" });
    expect(slotKeyToTourFields("2026-08-06:19")).toEqual({ tourDate: "2026-08-06", tourStart: "09:30" });
    expect(slotKeyToTourFields("2026-08-06:0")).toEqual({ tourDate: "2026-08-06", tourStart: "00:00" });
    expect(slotKeyToTourFields("2026-08-06:47")).toEqual({ tourDate: "2026-08-06", tourStart: "23:30" });
  });

  it("refuses a key that names no slot", () => {
    expect(slotKeyToTourFields("not-a-key")).toBeNull();
    expect(slotKeyToTourFields("2026-08-06:48")).toBeNull();
    expect(slotKeyToTourFields("2026-08-06:-1")).toBeNull();
  });
});

const HOSTS = [{ userId: "mgr-1", label: "Alex" }];

describe("openSlotKeysForDate / openTourDates — reading the same slotHosts the public grid reads", () => {
  const slotHosts = {
    "2026-08-06:18": HOSTS,
    "2026-08-06:20": HOSTS,
    "2026-08-06:22": [], // closed — no hosts left
    "2026-08-07:18": HOSTS,
  };

  it("lists only the OPEN slots for one date, earliest first", () => {
    expect(openSlotKeysForDate(slotHosts, "2026-08-06")).toEqual(["2026-08-06:18", "2026-08-06:20"]);
  });

  it("returns nothing for a date with no open slots", () => {
    expect(openSlotKeysForDate(slotHosts, "2026-09-01")).toEqual([]);
  });

  it("collects every date carrying at least one open slot", () => {
    expect(openTourDates(slotHosts)).toEqual(new Set(["2026-08-06", "2026-08-07"]));
  });
});

describe("fetchOpenTourSlotsForProperty — the client half of listOpenTourSlots", () => {
  it("reads the same public availability route the guest booking grid and every tour tool read", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ slotHosts: { "2026-08-06:18": HOSTS } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchOpenTourSlotsForProperty({ id: "prop_alder", buildingName: "Alder Row", address: "123 Alder St" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "/api/public/property-tour-availability?propertyId=prop_alder&buildingName=Alder+Row&address=123+Alder+St",
    );
    expect(result).toEqual({ ok: true, slotHosts: { "2026-08-06:18": HOSTS } });
  });

  it("surfaces a server error rather than pretending nothing is open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })),
    );
    const result = await fetchOpenTourSlotsForProperty({ id: "prop_alder" });
    expect(result).toEqual({ ok: false, error: "boom" });
  });

  it("never calls the network for an empty property id", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchOpenTourSlotsForProperty({ id: "" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, slotHosts: {} });
  });
});

describe("buildScheduleTourSimpleForm — payload parity with the old wizard", () => {
  it("produces exactly the AddPersonForm the old Contact → Home → Tour steps would have, for the same inputs", () => {
    const simple = buildScheduleTourSimpleForm({
      name: "Jamie Prospect",
      email: "jamie@example.com",
      phone: "+12065551234",
      propertyId: "prop_alder",
      roomId: "room_1",
      bundleId: "",
      tourFormat: "in_person",
      slotKey: "2026-08-06:18",
      tourNotes: "Meet at the gate",
    });

    // The old wizard built exactly this: emptyAddPersonForm("prospect") as the
    // base (so duration, preferred contact and message channels keep their
    // untouched defaults), then ContactStep/HomeStep/TourStep's own patches.
    const oldWizardEquivalent: AddPersonForm = {
      ...emptyAddPersonForm("prospect"),
      name: "Jamie Prospect",
      email: "jamie@example.com",
      phone: "+12065551234",
      propertyId: "prop_alder",
      roomId: "room_1",
      bundleId: "",
      tourFormat: "in_person",
      tourDate: "2026-08-06",
      tourStart: "09:00",
      tourNotes: "Meet at the gate",
    };

    expect(simple).toEqual(oldWizardEquivalent);
  });

  it("leaves tourDate/tourStart blank when no tour is wanted, same as the old wizard's 'No tour yet' pick", () => {
    const simple = buildScheduleTourSimpleForm({
      name: "Jamie Prospect",
      email: "jamie@example.com",
      phone: "",
      propertyId: "prop_alder",
      roomId: "",
      bundleId: "",
      tourFormat: "none",
      slotKey: "2026-08-06:18",
      tourNotes: "",
    });
    expect(simple.tourDate).toBe("");
    expect(simple.tourStart).toBe("");
  });

  it("leaves tourDate/tourStart blank when a tour is wanted but no slot has been picked yet", () => {
    const simple = buildScheduleTourSimpleForm({
      name: "Jamie Prospect",
      email: "",
      phone: "+12065551234",
      propertyId: "prop_alder",
      roomId: "",
      bundleId: "",
      tourFormat: "in_person",
      slotKey: null,
      tourNotes: "",
    });
    expect(simple.tourDate).toBe("");
    expect(simple.tourStart).toBe("");
  });
});


describe("manual tour host eligibility", () => {
  it("excludes slots offered only by another host and fails closed without an actor", () => {
    const other = { userId: "mgr-2", label: "Co-manager" };
    const union = { "2026-08-06:18": [other], "2026-08-06:19": [...HOSTS, other], "2026-08-06:20": [] };
    expect(tourSlotsForManager(union, "mgr-1")).toEqual({ "2026-08-06:19": HOSTS });
    expect(tourSlotsForManager(union, null)).toEqual({});
    // A once-open actor slot must disappear if only the co-manager remains on refresh.
    expect(tourSlotsForManager({ "2026-08-06:19": [other] }, "mgr-1")).toEqual({});
  });
});
