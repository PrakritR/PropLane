import { describe, expect, it } from "vitest";
import {
  VENDOR_NUMBER_FAIR_USE_SEGMENTS_PER_MONTH,
  VENDOR_NUMBER_IDLE_RELEASE_DAYS,
  decideVendorReplyRoute,
  forwardedTextBody,
  parseReplyChoice,
  replyPromptBody,
  vendorNumberMonthStart,
  vendorNumberSegments,
} from "@/lib/vendor-work-number";

const NOW = new Date("2026-10-06T18:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 3_600_000;
const alder = { counterpartPhone: "+12065550101", workspaceName: "Alder Property Co", lastActivityAt: ago(2 * HOUR) };
const greenLake = { counterpartPhone: "+12065550102", workspaceName: "Green Lake Rentals", lastActivityAt: ago(5 * HOUR) };

describe("the approved numbers", () => {
  it("is 1,000 segments a month and a 60 day idle release", () => {
    expect(VENDOR_NUMBER_FAIR_USE_SEGMENTS_PER_MONTH).toBe(1000);
    expect(VENDOR_NUMBER_IDLE_RELEASE_DAYS).toBe(60);
  });
  it("counts what the carrier bills: GSM 160/153, UCS-2 70/67", () => {
    expect(vendorNumberSegments("")).toBe(0);
    expect(vendorNumberSegments("a".repeat(160))).toBe(1);
    expect(vendorNumberSegments("a".repeat(161))).toBe(2);
    expect(vendorNumberSegments("a".repeat(307))).toBe(3);
    expect(vendorNumberSegments("é中".repeat(36))).toBe(2);
  });
  it("resets on the first of the UTC month", () => {
    expect(vendorNumberMonthStart(new Date("2026-10-31T23:59:59Z")).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("forwarded text label", () => {
  it("is [<Workspace>] <text>", () => {
    expect(forwardedTextBody("Alder Property Co", "Can you look at the sink?")).toBe("[Alder Property Co] Can you look at the sink?");
  });
  it("cannot be spoofed by brackets or newlines in a workspace name", () => {
    expect(forwardedTextBody("Evil]\n[Bank", "hi")).toBe("[Evil Bank] hi");
    expect(forwardedTextBody("", "hi")).toBe("[PropLane] hi");
  });
});

describe("reply routing: most recent conversation, numbered prompt when unclear", () => {
  it("routes to the one conversation active in the last 24h", () => {
    expect(decideVendorReplyRoute([alder], "Yes, Thursday 10am", NOW)).toEqual({ kind: "route", counterpartPhone: alder.counterpartPhone, body: "Yes, Thursday 10am" });
  });

  it("prefers the one active conversation over an older one", () => {
    const old = { ...greenLake, lastActivityAt: ago(72 * HOUR) };
    expect(decideVendorReplyRoute([old, alder], "ok", NOW)).toMatchObject({ kind: "route", counterpartPhone: alder.counterpartPhone });
  });

  it("asks when two managers are active in 24h, in a stable order", () => {
    const decision = decideVendorReplyRoute([greenLake, alder], "Thursday works", NOW);
    expect(decision).toEqual({
      kind: "prompt",
      choices: [
        { counterpartPhone: alder.counterpartPhone, workspaceName: "Alder Property Co" },
        { counterpartPhone: greenLake.counterpartPhone, workspaceName: "Green Lake Rentals" },
      ],
    });
    if (decision.kind === "prompt") expect(replyPromptBody(decision.choices)).toBe("Reply to: 1) Alder Property Co 2) Green Lake Rentals — reply with the number first.");
  });

  it("the numbered reply picks that conversation and strips the number", () => {
    expect(decideVendorReplyRoute([alder, greenLake], "2 Thursday works", NOW)).toEqual({ kind: "route", counterpartPhone: greenLake.counterpartPhone, body: "Thursday works" });
    expect(decideVendorReplyRoute([alder, greenLake], "1: on my way", NOW)).toMatchObject({ kind: "route", counterpartPhone: alder.counterpartPhone, body: "on my way" });
  });

  it("an out-of-range number is not a choice - it asks again", () => {
    expect(decideVendorReplyRoute([alder, greenLake], "3 hello", NOW).kind).toBe("prompt");
  });

  it("asks when none is recent, naming the older conversations (even one)", () => {
    const stale = { ...alder, lastActivityAt: ago(48 * HOUR) };
    expect(decideVendorReplyRoute([stale], "hi", NOW)).toEqual({ kind: "prompt", choices: [{ counterpartPhone: stale.counterpartPhone, workspaceName: stale.workspaceName }] });
    expect(decideVendorReplyRoute([stale], "1 hi", NOW)).toMatchObject({ kind: "route", counterpartPhone: stale.counterpartPhone, body: "hi" });
  });

  it("does not offer a conversation nobody has touched in 30 days", () => {
    expect(decideVendorReplyRoute([{ ...alder, lastActivityAt: ago(31 * 24 * HOUR) }], "hi", NOW)).toEqual({ kind: "none" });
    expect(decideVendorReplyRoute([], "hi", NOW)).toEqual({ kind: "none" });
  });

  it("with exactly one recent conversation a leading digit is just part of the message", () => {
    expect(decideVendorReplyRoute([alder, { ...greenLake, lastActivityAt: ago(48 * HOUR) }], "2 pm works", NOW)).toMatchObject({ kind: "route", counterpartPhone: alder.counterpartPhone, body: "2 pm works" });
  });
});

describe("parseReplyChoice", () => {
  it("needs a body after the number", () => {
    expect(parseReplyChoice("2", 3)).toBeNull();
    expect(parseReplyChoice("2 ", 3)).toBeNull();
    expect(parseReplyChoice("12 hello", 3)).toBeNull();
    expect(parseReplyChoice("2) hello", 3)).toEqual({ index: 1, body: "hello" });
  });
});
