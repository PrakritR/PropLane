import { describe, expect, it } from "vitest";
import {
  composeApprovalText,
  composeExhaustedText,
  composeQuoteAskText,
  composeVendorConfirmText,
  composeVendorOfferText,
  stripContactDetails,
  toGsm7,
} from "@/lib/vendor-dispatch/text";
import {
  parseManagerDispatchReply,
  parseResidentFixedReply,
  parseVendorDispatchReply,
} from "@/lib/vendor-dispatch/reply-parse";
import { isBusinessHoursPacific, parseVendorProposedTime } from "@/lib/vendor-dispatch/time";
import { inferDispatchFromService, textIsDangerous, triageGuidanceForPrompt } from "@/lib/vendor-dispatch/triage";

describe("vendor offer text", () => {
  const details = {
    what: "Lockout",
    area: "Capitol Hill",
    address: "5259 Brooklyn Ave NE, Seattle",
    houseLabel: "5259 Brooklyn",
    room: "R3",
    personFirstName: "Dana",
    entryNote: "call first",
  };

  it("shows the area, never the street address, before a vendor accepts", () => {
    const text = composeVendorOfferText({ handle: 7, details, payCents: 12000, payModel: "flat" });
    expect(text).toContain("Capitol Hill");
    expect(text).not.toContain("5259");
    expect(text).not.toContain("Brooklyn");
    expect(text).toContain("#7");
    expect(text).toContain("$120");
    expect(text).toMatch(/YES, NO or BUSY/);
  });

  it("is one GSM-7 segment: no emoji, curly quotes or long dashes", () => {
    const text = composeVendorOfferText({
      handle: 12,
      details: { ...details, what: "Lockout — “quick” 🔑", whenLabel: "now" },
      payCents: 12000,
      payModel: "flat",
    });
    expect(text.length).toBeLessThanOrEqual(160);
    expect(text).toBe(toGsm7(text));
    expect(text).not.toMatch(/[—“”]/);
  });

  it("says quote when the pay model is a quote, and names the deadline for turnovers", () => {
    const quote = composeVendorOfferText({ handle: 3, details: { what: "Leak", area: "Ballard" }, payCents: null, payModel: "quote" });
    expect(quote).toMatch(/Pay: your quote/);
    const turnover = composeVendorOfferText({
      handle: 4,
      details: { what: "Turnover clean", area: "Fremont", deadlineLabel: "check-in Oct 21" },
      payCents: 9000,
      payModel: "flat",
    });
    expect(turnover).toContain("done by check-in Oct 21");
  });

  it("never carries a resident's phone or email, even from free text", () => {
    const dirty = stripContactDetails("Call Dana at (206) 555-0142 or dana@example.com, 206-555-0142 after 5");
    expect(dirty).not.toMatch(/\d{3}[\s.-]?\d{4}/);
    expect(dirty).not.toContain("@");
    const confirm = composeVendorConfirmText({
      handle: 7,
      details: { ...details, entryNote: "text Dana at 206-555-0142 or dana@example.com" },
      whenLabel: "2:30pm",
    });
    expect(confirm).not.toMatch(/555-0142/);
    expect(confirm).not.toContain("@");
    expect(confirm).toContain("5259 Brooklyn Ave NE");
  });
});

describe("manager text", () => {
  it("fits the approval in one segment and degrades gracefully for long names", () => {
    const text = composeApprovalText({
      handle: 7,
      what: "Lockout",
      houseLabel: "5259 Brooklyn",
      room: "R3",
      vendorNames: ["Sam Locksmith", "Lee", "Kim"],
      payCents: 12000,
      payModel: "flat",
      mode: "sequential",
    });
    expect(text).toBe("Lockout 5259 Brooklyn R3 #7. Send Sam Locksmith $120, then Lee, Kim if busy? Y/N or 1-3 to pick one");
    const long = composeApprovalText({
      handle: 21,
      what: "Plumbing leak in the second floor bathroom",
      houseLabel: "4709A Eighth Avenue Northeast Apartments",
      room: "Room 12",
      vendorNames: ["Northwest Premier Plumbing and Drain Services Incorporated", "Another Very Long Plumber Name LLC", "Third Plumbing Co"],
      payCents: null,
      payModel: "quote",
      mode: "sequential",
    });
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long).toContain("#21");
  });

  it("states a broadcast as all at once and a quote hold with its cap", () => {
    const broadcast = composeApprovalText({ handle: 2, what: "Turnover", houseLabel: "5257", vendorNames: ["Ana", "Bo"], payCents: 9000, payModel: "flat", mode: "broadcast" });
    expect(broadcast).toContain("Ana, Bo at once");
    expect(composeQuoteAskText({ handle: 7, vendorName: "Mike Plumbing", quoteCents: 24000, capCents: 18000 })).toBe("Mike quotes $240 (cap $180) #7. Y/N");
    expect(composeExhaustedText({ handle: 7, tradeLabel: "Cleaner" })).toBe("No one took #7. R to retry, B to offer all cleaners at once, or handle it yourself");
  });
});

describe("manager reply grammar", () => {
  it.each([
    ["Y", { kind: "approve", handle: null }],
    ["yes", { kind: "approve", handle: null }],
    ["Y 7", { kind: "approve", handle: 7 }],
    ["yes #7", { kind: "approve", handle: 7 }],
    ["N", { kind: "decline", handle: null }],
    ["N 7", { kind: "decline", handle: 7 }],
    ["2", { kind: "pick", position: 2, handle: null }],
    ["2 7", { kind: "pick", position: 2, handle: 7 }],
    ["R", { kind: "retry", handle: null }],
    ["B 7", { kind: "broadcast", handle: 7 }],
  ])("parses %s", (body, expected) => {
    expect(parseManagerDispatchReply(body)).toEqual(expected);
  });

  it.each(["yes please send it", "maybe", "7 houses", "Y 7 8", "call me", ""])("leaves %j alone", (body) => {
    expect(parseManagerDispatchReply(body)).toBeNull();
  });
});

describe("vendor reply grammar", () => {
  it("reads YES with a time, a price and a job number", () => {
    expect(parseVendorDispatchReply("YES 2:30pm")).toMatchObject({ kind: "yes", handle: null, timeText: "2:30pm", priceCents: null });
    expect(parseVendorDispatchReply("yes $240")).toMatchObject({ kind: "yes", priceCents: 24000, timeText: null });
    expect(parseVendorDispatchReply("YES 7")).toMatchObject({ kind: "yes", handle: 7, timeText: null });
    expect(parseVendorDispatchReply("YES #7 tomorrow 9am for $180")).toMatchObject({ kind: "yes", handle: 7, priceCents: 18000, timeText: "tomorrow 9am" });
  });

  it("reads NO, BUSY with a duration, DONE and INVOICE", () => {
    expect(parseVendorDispatchReply("no")).toEqual({ kind: "no", handle: null });
    expect(parseVendorDispatchReply("BUSY")).toEqual({ kind: "busy", handle: null, minutes: 120 });
    expect(parseVendorDispatchReply("busy 4h")).toEqual({ kind: "busy", handle: null, minutes: 240 });
    expect(parseVendorDispatchReply("BUSY 7 30m")).toEqual({ kind: "busy", handle: 7, minutes: 30 });
    expect(parseVendorDispatchReply("DONE")).toEqual({ kind: "done", handle: null, note: null });
    expect(parseVendorDispatchReply("INVOICE $240")).toEqual({ kind: "invoice", handle: null, amountCents: 24000 });
    expect(parseVendorDispatchReply("invoice #7 $240.50")).toEqual({ kind: "invoice", handle: 7, amountCents: 24050 });
    expect(parseVendorDispatchReply("invoice 240")).toEqual({ kind: "invoice", handle: null, amountCents: 24000 });
  });

  it("does not claim ordinary conversation", () => {
    expect(parseVendorDispatchReply("what is the address?")).toBeNull();
    expect(parseVendorDispatchReply("I can come tomorrow")).toBeNull();
  });

  it("reads the resident's fixed answer", () => {
    expect(parseResidentFixedReply("YES")).toBe("fixed");
    expect(parseResidentFixedReply("no.")).toBe("not_fixed");
    expect(parseResidentFixedReply("yes but also the sink")).toBeNull();
  });
});

describe("pacific time", () => {
  it("knows business hours as Monday to Friday 8 to 18 Pacific", () => {
    expect(isBusinessHoursPacific(new Date("2026-10-19T16:00:00Z"))).toBe(true); // Mon 9:00 PDT
    expect(isBusinessHoursPacific(new Date("2026-10-19T14:59:00Z"))).toBe(false); // Mon 7:59 PDT
    expect(isBusinessHoursPacific(new Date("2026-10-20T01:00:00Z"))).toBe(false); // Mon 18:00 PDT
    expect(isBusinessHoursPacific(new Date("2026-10-24T18:00:00Z"))).toBe(false); // Saturday
  });

  it("reads a vendor's proposed time in Pacific, never on a guess", () => {
    const now = new Date("2026-10-19T20:00:00Z"); // Mon 1:00pm PDT
    expect(parseVendorProposedTime("2:30pm", now)?.toISOString()).toBe("2026-10-19T21:30:00.000Z");
    expect(parseVendorProposedTime("9am", now)?.toISOString()).toBe("2026-10-20T16:00:00.000Z"); // next 9am
    expect(parseVendorProposedTime("tomorrow 9am", now)?.toISOString()).toBe("2026-10-20T16:00:00.000Z");
    expect(parseVendorProposedTime("in 2h", now)?.toISOString()).toBe("2026-10-19T22:00:00.000Z");
    expect(parseVendorProposedTime("fri 3pm", now)?.toISOString()).toBe("2026-10-23T22:00:00.000Z");
    expect(parseVendorProposedTime("asap", now)).toBeNull();
    expect(parseVendorProposedTime("", now)).toBeNull();
    expect(parseVendorProposedTime("whenever", now)).toBeNull();
  });
});

describe("triage", () => {
  it("maps a service to a vendor role, issue and urgency", () => {
    expect(inferDispatchFromService({ category: "access", title: "Locked out", description: "I'm locked out of my room", priority: "Emergency" })).toEqual({
      trade: "locksmith",
      issue: "lockout",
      urgency: "emergency",
    });
    expect(inferDispatchFromService({ category: "plumbing", title: "Leak reported", description: "kitchen sink is leaking", priority: "Medium" })).toEqual({
      trade: "plumber",
      issue: "leak",
      urgency: "emergency",
    });
    expect(inferDispatchFromService({ category: "plumbing", title: "Sink issue", description: "faucet drips", priority: "Medium" })).toEqual({
      trade: "plumber",
      issue: "fixture",
      urgency: "routine",
    });
    expect(inferDispatchFromService({ category: "general", title: "Smoke alarm", description: "smoke alarm is chirping every minute", priority: "Medium" })).toMatchObject({
      trade: "handyman",
      issue: "alarm_chirp",
    });
  });

  it("never dispatches a gas smell, fire or smoke", () => {
    expect(inferDispatchFromService({ category: "plumbing", title: "Gas", description: "I smell gas in the kitchen", priority: "Emergency" })).toBeNull();
    expect(inferDispatchFromService({ category: "electrical", title: "Outlet", description: "outlet is smoking", priority: "Emergency" })).toBeNull();
    expect(textIsDangerous("there is a fire in the garage")).toBe(true);
    expect(textIsDangerous("the fireplace damper is stuck")).toBe(false);
  });

  it("puts 911 first in the intake guidance", () => {
    const guidance = triageGuidanceForPrompt();
    expect(guidance).toMatch(/911/);
    expect(guidance).toMatch(/lockout/i);
    expect(guidance).not.toMatch(/—/);
  });
});
