import { describe, expect, it } from "vitest";
import { looksLikeGigRequest, newGigCode, parseGigAmount, parseGigReply, parseGigRequest, readGigHomeHint, readGigKind, readGigWhen, GIG_CODE_RE } from "@/lib/jobs/gig-parse";

// Wednesday 2026-11-11 12:00 Pacific
const NOW = new Date("2026-11-11T20:00:00Z");

describe("gig amounts are read by code", () => {
  it("reads $40 from a tour ask", () => {
    expect(parseGigAmount("need someone to show 4709A Room 3 Saturday 2pm, I'll pay $40")).toEqual({ kind: "value", amountCents: 4000 });
  });
  it("reads thousands separators, cents and 'dollars'", () => {
    expect(parseGigAmount("$1,200")).toEqual({ kind: "value", amountCents: 120000 });
    expect(parseGigAmount("pay $40.50")).toEqual({ kind: "value", amountCents: 4050 });
    expect(parseGigAmount("for 60 dollars")).toEqual({ kind: "value", amountCents: 6000 });
  });
  it("never reads a street number or a time as money", () => {
    expect(parseGigAmount("show 5257 at 2pm")).toEqual({ kind: "none" });
  });
  it("refuses two different figures and absurd ones", () => {
    expect(parseGigAmount("$40 or $60")).toMatchObject({ kind: "ambiguous" });
    expect(parseGigAmount("$40 and $40")).toEqual({ kind: "value", amountCents: 4000 });
    expect(parseGigAmount("$1")).toMatchObject({ kind: "too_high" });
    expect(parseGigAmount("$50,000")).toMatchObject({ kind: "too_high" });
  });
});

describe("gig kind, when and home", () => {
  it("tells a tour from a cleaning", () => {
    expect(readGigKind("need someone to show a tour")).toBe("tour_showing");
    expect(readGigKind("need my rooms cleaned at 5257 this week, $120")).toBe("cleaning");
    expect(readGigKind("need someone to move a couch")).toBe("other");
  });
  it("resolves Saturday 2pm to the next Saturday in Pacific time", () => {
    const when = readGigWhen("show it Saturday 2pm", NOW);
    expect(when.text).toBe("Saturday 2pm");
    expect(when.startIso).toBe("2026-11-14T22:00:00.000Z");
  });
  it("keeps a vague window as words only", () => {
    expect(readGigWhen("cleaned this week", NOW)).toEqual({ text: "This week", startIso: null });
  });
  it("reads a street number and room as a hint only", () => {
    expect(readGigHomeHint("show 4709A Room 3 Saturday")).toEqual({ streetNumber: "4709a", roomLabel: "Room 3" });
    expect(readGigHomeHint("cleaned at 5257, $120")).toEqual({ streetNumber: "5257", roomLabel: null });
  });
  it("parses the whole ask", () => {
    const parsed = parseGigRequest("need someone to show 4709A Room 3 Saturday 2pm, I'll pay $40", NOW);
    expect(parsed.kind).toBe("tour_showing");
    expect(parsed.amount).toEqual({ kind: "value", amountCents: 4000 });
    expect(parsed.home.roomLabel).toBe("Room 3");
  });
});

describe("what counts as a gig ask", () => {
  it("accepts the captain's two examples", () => {
    expect(looksLikeGigRequest("I need someone to schedule a tour for me, I will pay $40 for this tour")).toBe(true);
    expect(looksLikeGigRequest("I need someone to clean my rooms, I will pay $120")).toBe(true);
  });
  it("ignores repair reports, rent questions and unpriced chatter", () => {
    expect(looksLikeGigRequest("the kitchen sink is leaking")).toBe(false);
    expect(looksLikeGigRequest("what is the rent for room 3?")).toBe(false);
    expect(looksLikeGigRequest("I need someone")).toBe(false);
  });
});

describe("a vendor's reply", () => {
  it("reads accept and decline, with or without the code", () => {
    expect(parseGigReply("YES")).toEqual({ action: "accept", code: null });
    expect(parseGigReply("yes k7q2")).toEqual({ action: "accept", code: "K7Q2" });
    expect(parseGigReply("I'll take it!")).toEqual({ action: "accept", code: null });
    expect(parseGigReply("no")).toEqual({ action: "decline", code: null });
    expect(parseGigReply("pass K7Q2")).toEqual({ action: "decline", code: "K7Q2" });
  });
  it("ignores sentences and codes with forbidden letters", () => {
    expect(parseGigReply("yes please send the address and the rate")).toBeNull();
    expect(parseGigReply("yes 0O1I")).toBeNull();
    expect(parseGigReply("what is this")).toBeNull();
  });
  it("makes codes in the safe alphabet", () => {
    for (let i = 0; i < 50; i += 1) expect(newGigCode()).toMatch(GIG_CODE_RE);
  });
});
