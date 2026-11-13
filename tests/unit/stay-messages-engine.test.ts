/**
 * design-1112 §7 acceptance 7: the scheduler driven by a clock and an in-memory ledger through the real sweep.
 * Room 4 / gate 075 / front door come from the property record; only the guest's OWN room code is ever in the body.
 */
import { describe, expect, it } from "vitest";
import { normalizeHouseInfo } from "@/lib/house-info";
import { runStayMessageSweep } from "@/lib/stay-messages/sweep.server";
import { DEFAULT_STAY_MESSAGE_SETTINGS, normalizeStayMessageSettings, type StayMessageSettings } from "@/lib/stay-messages/templates";
import type { ChannelResults, LedgerInsert, LedgerRow, StayCandidate, StayMessageDeps, StayMessageSendInput, StayProperty } from "@/lib/stay-messages/types";

const FRONT = "1357";
const GATE = "075";
const LOCKBOX = "9911";

function property(over: Partial<StayProperty> = {}): StayProperty {
  return {
    propertyId: "prop-5259",
    label: "5259 Brooklyn Ave NE",
    addressLine: "5259 Brooklyn Ave NE, Seattle, 98105",
    timeZone: "America/Los_Angeles",
    houseInfo: normalizeHouseInfo({
      access: { doorCode: FRONT, gateCode: GATE },
      wifi: { network: "Brooklyn5259", password: "wifipass" },
      rules: { bathroom: "Use the bathroom on your own floor." },
      checkout: { trash: "Take the trash to the curb." },
      internal: { lockboxCode: LOCKBOX },
    }),
    rooms: [
      { id: "room-3", label: "Room 3", doorCode: "3333" },
      { id: "room-4", label: "Room 4", doorCode: "4444" },
      { id: "room-5", label: "Room 5", doorCode: "5555" },
    ],
    ...over,
  };
}

function stay(over: Partial<StayCandidate> = {}): StayCandidate {
  return {
    stayKey: "block:b1",
    stayKind: "block",
    workspaceId: "ws-1",
    ownerUserId: "owner-1",
    propertyId: "prop-5259",
    roomId: "room-4",
    source: "direct",
    status: "confirmed",
    guestName: "Jordan Lee",
    guestEmail: "jordan@example.com",
    guestPhone: "+12065550142",
    guestUserId: null,
    checkIn: "2026-11-20",
    checkOut: "2026-11-23",
    checkInTime: "15:00",
    checkOutTime: "11:00",
    createdAt: "2026-11-01T00:00:00Z",
    leaseSigned: true,
    ...over,
  };
}

function harness(initial: { stays: StayCandidate[]; property?: StayProperty; settings?: StayMessageSettings }) {
  const state = {
    now: new Date("2026-11-19T17:00:00Z"),
    stays: initial.stays,
    property: initial.property ?? property(),
    settings: initial.settings ?? DEFAULT_STAY_MESSAGE_SETTINGS,
    rows: [] as LedgerRow[],
    sends: [] as StayMessageSendInput[],
    flags: [] as string[],
    issues: [] as string[],
    failChannel: null as null | "sms",
    crashAfterSms: false,
    smsTexts: 0,
    stale: false,
  };
  let counter = 0;
  const ledger = {
    async find(stayKey: string, kind: LedgerRow["kind"], factsHash?: string | null) {
      return state.rows.find((r) => r.stayKey === stayKey && r.kind === kind && (kind !== "check_in_correction" || !factsHash || r.factsHash === factsHash)) ?? null;
    },
    async insert(input: LedgerInsert) {
      const existing = state.rows.find((r) => r.stayKey === input.stayKey && r.kind === input.kind && (input.kind !== "check_in_correction" || r.factsHash === input.factsHash));
      if (existing) return { row: existing, created: false };
      counter += 1;
      const row: LedgerRow = {
        id: `row-${counter}`, stayKey: input.stayKey, kind: input.kind, status: input.status, holdReason: input.holdReason ?? null,
        dueAt: input.dueAt, sentAt: null, roomId: input.roomId, factsHash: input.factsHash, channels: {}, threadId: null, updatedAt: String(counter),
      };
      state.rows.push(row);
      return { row, created: true };
    },
    async claim(row: LedgerRow) {
      const live = state.rows.find((r) => r.id === row.id)!;
      if (live.updatedAt !== row.updatedAt) return false;
      if (live.status === "sending" && !state.stale) return false; // claim-before-send: another sweep is sending it
      live.status = "sending";
      live.updatedAt = `${live.updatedAt}+`;
      return true;
    },
    async update(id: string, patch: Partial<LedgerRow>) {
      const live = state.rows.find((r) => r.id === id)!;
      Object.assign(live, patch);
      live.updatedAt = `${live.updatedAt}.`;
    },
  };
  const deps: StayMessageDeps = {
    now: () => state.now,
    loadCandidates: async () => state.stays,
    loadProperty: async () => state.property,
    loadSettings: async () => state.settings,
    ledger,
    send: async (input) => {
      state.sends.push(input);
      const out: ChannelResults = {};
      if (input.already.sms?.status !== "sent") {
        out.sms = state.failChannel === "sms" ? { status: "failed", reason: "carrier refused" } : { status: "sent" };
        if (out.sms.status === "sent") state.smsTexts += 1;
        await input.checkpoint?.({ sms: out.sms });
        if (state.crashAfterSms) throw new Error("process died after the text");
      }
      if (input.already.email?.status !== "sent") out.email = { status: "sent" };
      if (input.already.inbox?.status !== "sent") out.inbox = { status: "sent" };
      return out;
    },
    flagManager: async (flag) => { state.flags.push(flag.text); },
    recordIssue: async (issue) => { state.issues.push(`${issue.channel}:${issue.reason}`); },
  };
  return { state, run: () => runStayMessageSweep(deps) };
}

describe("check-in: 10:00 the day before, exactly once", () => {
  it("sends nothing before 10:00, one message at 10:00, and still one after repeated sweeps", async () => {
    const h = harness({ stays: [stay()] });
    h.state.now = new Date("2026-11-19T17:59:00Z"); // 09:59 PST
    await h.run();
    expect(h.state.sends).toHaveLength(0);
    h.state.now = new Date("2026-11-19T18:00:00Z"); // 10:00 PST
    await h.run();
    await h.run();
    h.state.now = new Date("2026-11-19T18:05:00Z");
    await h.run();
    expect(h.state.sends).toHaveLength(1);
    expect(h.state.rows.filter((r) => r.kind === "check_in")).toHaveLength(1);
    expect(h.state.rows[0]!.status).toBe("sent");
  });

  it("carries Room 4, the gate and front door codes, and the guest's OWN room code only", async () => {
    const h = harness({ stays: [stay()] });
    h.state.now = new Date("2026-11-19T18:00:00Z");
    await h.run();
    const body = h.state.sends[0]!.body;
    expect(body).toContain("Hi Jordan");
    expect(body).toContain(`Front door code: ${FRONT}`);
    expect(body).toContain(`Gate code: ${GATE}`);
    expect(body).toContain("Your Room 4 code: 4444");
    expect(body).toContain("Brooklyn5259");
    expect(body).toContain("Use the bathroom on your own floor.");
    expect(body).toContain("(206) 678-1909");
    for (const other of ["3333", "5555", LOCKBOX]) expect(body).not.toContain(other);
    expect(h.state.sends[0]!.smsBody).toContain("4444");
  });

  it("looks the room up by its structured id, so swapped labels still give the right code", async () => {
    const swapped = property({
      rooms: [
        { id: "room-4", label: "Room 3", doorCode: "4444" },
        { id: "room-3", label: "Room 4", doorCode: "3333" },
      ],
    });
    const h = harness({ stays: [stay({ roomId: "room-4" })], property: swapped });
    h.state.now = new Date("2026-11-19T18:00:00Z");
    await h.run();
    const body = h.state.sends[0]!.body;
    expect(body).toContain("Your Room 3 code: 4444");
    expect(body).not.toContain("3333");
  });

  it("a house without a gate prints no gate line", async () => {
    const info = normalizeHouseInfo({ access: { doorCode: FRONT }, wifi: { network: "n", password: "p" } });
    const h = harness({ stays: [stay()], property: property({ houseInfo: info }) });
    h.state.now = new Date("2026-11-19T18:00:00Z");
    await h.run();
    expect(h.state.sends[0]!.body).not.toMatch(/gate/i);
  });

  it("a booking made inside the window is sent promptly, once", async () => {
    const h = harness({ stays: [stay({ createdAt: "2026-11-19T23:00:00Z" })] });
    h.state.now = new Date("2026-11-19T23:05:00Z");
    await h.run();
    await h.run();
    expect(h.state.sends).toHaveLength(1);
  });

  it("never texts a stay already under way (past check-in plus the grace)", async () => {
    const h = harness({ stays: [stay()] });
    h.state.now = new Date("2026-11-21T20:00:00Z");
    await h.run();
    expect(h.state.sends.filter((s) => s.kind === "check_in")).toHaveLength(0);
  });
});

describe("check-out: 09:00 on the day", () => {
  it("sends one message at 09:00 on the check-out date and not again", async () => {
    const h = harness({ stays: [stay()] });
    h.state.now = new Date("2026-11-23T16:59:00Z");
    await h.run();
    expect(h.state.sends.filter((s) => s.kind === "check_out")).toHaveLength(0);
    h.state.now = new Date("2026-11-23T17:00:00Z");
    await h.run();
    await h.run();
    const outs = h.state.sends.filter((s) => s.kind === "check_out");
    expect(outs).toHaveLength(1);
    expect(outs[0]!.body).toContain("11:00 am");
    expect(outs[0]!.body).toContain("Take the trash to the curb.");
    expect(outs[0]!.body).not.toMatch(/4444|1357|075/);
  });
});

describe("cancelled and unconfirmed stays", () => {
  it("a cancelled booking never gets a message and writes no ledger row", async () => {
    const h = harness({ stays: [stay({ status: "cancelled" })] });
    h.state.now = new Date("2026-11-19T18:00:00Z");
    await h.run();
    h.state.now = new Date("2026-11-23T17:00:00Z");
    await h.run();
    expect(h.state.sends).toHaveLength(0);
    expect(h.state.rows).toHaveLength(0);
  });

  it("a held row is marked cancelled when the booking is cancelled before the code is fixed", async () => {
    const noCode = property({ rooms: [{ id: "room-4", label: "Room 4", doorCode: "" }] });
    const h = harness({ stays: [stay()], property: noCode });
    h.state.now = new Date("2026-11-19T18:00:00Z");
    await h.run();
    expect(h.state.rows[0]!.status).toBe("held");
    h.state.stays = [stay({ status: "cancelled" })];
    await h.run();
    expect(h.state.rows[0]!.status).toBe("cancelled");
    expect(h.state.sends).toHaveLength(0);
  });

  it("a hold (not confirmed) or an unsigned lease gets nothing", async () => {
    const h = harness({ stays: [stay({ status: "hold" }), stay({ stayKey: "lease:l1", stayKind: "lease", leaseSigned: false })] });
    h.state.now = new Date("2026-11-19T18:00:00Z");
    await h.run();
    expect(h.state.sends).toHaveLength(0);
  });
});

describe("empty room code: held, flagged, never a fallback", () => {
  it("sends nothing, holds with room_code_missing, flags the manager once, then sends when the code is added", async () => {
    const noCode = property({ rooms: [{ id: "room-3", label: "Room 3", doorCode: "3333" }, { id: "room-4", label: "Room 4", doorCode: "" }] });
    const h = harness({ stays: [stay()], property: noCode });
    h.state.now = new Date("2026-11-19T18:00:00Z");
    await h.run();
    await h.run();
    h.state.now = new Date("2026-11-19T18:05:00Z");
    await h.run();
    expect(h.state.sends).toHaveLength(0);
    expect(h.state.rows).toHaveLength(1);
    expect(h.state.rows[0]).toMatchObject({ status: "held", holdReason: "room_code_missing" });
    expect(h.state.flags).toHaveLength(1);
    expect(h.state.flags[0]).toContain("Room 4");
    expect(h.state.flags[0]).toContain("no door code");
    // the manager fills it in: the same row sends, once
    h.state.property = property();
    await h.run();
    await h.run();
    expect(h.state.sends).toHaveLength(1);
    expect(h.state.rows[0]!.status).toBe("sent");
  });

  it("a stay whose room matches no listed room is held too", async () => {
    const h = harness({ stays: [stay({ roomId: "ghost" })] });
    h.state.now = new Date("2026-11-19T18:00:00Z");
    await h.run();
    expect(h.state.sends).toHaveLength(0);
    expect(h.state.rows[0]!.holdReason).toBe("room_code_missing");
  });

  it("refuses a body that would carry another room's code (foreign_code)", async () => {
    const leaky = property({
      houseInfo: normalizeHouseInfo({ access: { doorCode: FRONT }, checkout: { trash: "Room 3 code is 3333, use it for the shed." } }),
    });
    const h = harness({ stays: [stay()], property: leaky });
    h.state.now = new Date("2026-11-23T17:00:00Z");
    await h.run();
    // the check-out template prints the house's checkout steps
    expect(h.state.sends.filter((s) => s.kind === "check_out")).toHaveLength(0);
  });
});

describe("per-source toggle and contact phone", () => {
  it("Airbnb and Booking.com guests get nothing by default", async () => {
    const h = harness({ stays: [stay({ source: "airbnb" }), stay({ stayKey: "block:b2", source: "booking_com" })] });
    h.state.now = new Date("2026-11-19T18:00:00Z");
    await h.run();
    expect(h.state.sends).toHaveLength(0);
  });

  it("with the toggle on, an Airbnb guest sees the host line, a direct guest the PropLane line", async () => {
    const settings = normalizeStayMessageSettings({ sources: { airbnb: true } });
    const h = harness({ stays: [stay({ source: "airbnb" }), stay({ stayKey: "block:b2", source: "direct" })], settings });
    h.state.now = new Date("2026-11-19T18:00:00Z");
    await h.run();
    const byKey = new Map(h.state.sends.map((s) => [s.candidate.stayKey, s.body]));
    expect(byKey.get("block:b1")).toContain("(510) 309-8345");
    expect(byKey.get("block:b1")).not.toContain("678-1909");
    expect(byKey.get("block:b2")).toContain("(206) 678-1909");
  });

  it("a nameless contact-less stay is skipped", async () => {
    const h = harness({ stays: [stay({ guestEmail: null, guestPhone: null, guestUserId: null })] });
    h.state.now = new Date("2026-11-19T18:00:00Z");
    await h.run();
    expect(h.state.sends).toHaveLength(0);
  });
});

describe("failures are visible and retried per channel", () => {
  it("a failed text is recorded, raises an issue, and the retry sends only the text", async () => {
    const h = harness({ stays: [stay()] });
    h.state.now = new Date("2026-11-19T18:00:00Z");
    h.state.failChannel = "sms";
    await h.run();
    expect(h.state.rows[0]!.status).toBe("partial");
    expect(h.state.issues[0]).toContain("sms");
    h.state.failChannel = null;
    await h.run();
    expect(h.state.sends).toHaveLength(2);
    expect(h.state.sends[1]!.already.email?.status).toBe("sent");
    expect(h.state.rows[0]!.status).toBe("sent");
    await h.run();
    expect(h.state.sends).toHaveLength(2);
  });
});

describe("correction: once, when the room or dates change after the check-in went out", () => {
  it("sends one 'Update' message for a room move and not again", async () => {
    const h = harness({ stays: [stay()] });
    h.state.now = new Date("2026-11-19T18:00:00Z");
    await h.run();
    expect(h.state.sends).toHaveLength(1);
    h.state.stays = [stay({ roomId: "room-5" })];
    h.state.now = new Date("2026-11-19T19:00:00Z");
    await h.run();
    await h.run();
    const corrections = h.state.sends.filter((s) => s.kind === "check_in_correction");
    expect(corrections).toHaveLength(1);
    expect(corrections[0]!.body).toMatch(/^Update: your stay details changed, you are now in Room 5\./);
    expect(corrections[0]!.body).toContain("5555");
    expect(corrections[0]!.body).not.toContain("4444");
    // a second, different change makes a second correction; the same one never repeats
    h.state.stays = [stay({ roomId: "room-5", checkOut: "2026-11-24" })];
    await h.run();
    await h.run();
    expect(h.state.sends.filter((s) => s.kind === "check_in_correction")).toHaveLength(2);
  });

  it("no correction when nothing changed", async () => {
    const h = harness({ stays: [stay()] });
    h.state.now = new Date("2026-11-19T18:00:00Z");
    await h.run();
    h.state.now = new Date("2026-11-20T01:00:00Z");
    await h.run();
    expect(h.state.sends).toHaveLength(1);
  });
});

describe("claim-before-send closes the crash window", () => {
  it("a sweep that dies after the text leaves a 'sending' row: a second sweep cannot send, and a stale re-claim never repeats the text", async () => {
    const h = harness({ stays: [stay()] });
    h.state.now = new Date("2026-11-19T18:00:00Z");
    h.state.crashAfterSms = true;
    await h.run(); // the per-stay catch swallows the crash; the row stays claimed
    expect(h.state.rows[0]!.status).toBe("sending");
    expect(h.state.smsTexts).toBe(1);
    h.state.crashAfterSms = false;
    await h.run(); // claim still fresh: refused, nothing sent
    expect(h.state.smsTexts).toBe(1);
    expect(h.state.rows[0]!.status).toBe("sending");
    h.state.stale = true; // ten minutes later the claim is stale and may be taken over
    await h.run();
    expect(h.state.smsTexts).toBe(1); // the checkpointed text is never repeated
    expect(h.state.rows[0]!.status).toBe("sent");
    expect(h.state.sends.at(-1)!.already.sms?.status).toBe("sent");
  });

  it("two overlapping sweeps: only the one that wins the claim sends", async () => {
    const h = harness({ stays: [stay()] });
    h.state.now = new Date("2026-11-19T18:00:00Z");
    await Promise.all([h.run(), h.run()]);
    expect(h.state.smsTexts).toBe(1);
    expect(h.state.sends).toHaveLength(1);
  });
});

describe("contact phone is a per-source setting, never a template literal", () => {
  it("a long-term resident source takes its own number; an edited number wins", async () => {
    const settings = normalizeStayMessageSettings({ contactPhone: { resident: "+12065550100", direct: "not a number" } });
    expect(settings.contactPhone.resident).toBe("+12065550100");
    expect(settings.contactPhone.direct).toBe("+12066781909");
    const h = harness({ stays: [stay({ source: "resident" })], settings });
    h.state.now = new Date("2026-11-19T18:00:00Z");
    await h.run();
    expect(h.state.sends[0]!.body).toContain("(206) 555-0100");
    expect(h.state.sends[0]!.body).not.toContain("678-1909");
  });
});
