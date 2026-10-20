// W24: a vendor asking for work on the PropLane line is read by code. The captain's own sentence, the trade + area
// forms, and the texts that must NOT read as a vendor (a searcher who mentions a job, a clean room).
import { describe, expect, it } from "vitest";
import { inferSenderRole } from "@/lib/one-number/onboarding/role-detect";
import { asksForJobs, readVendorJobsAsk, readVendorQuestion, tradeLabelFor } from "@/lib/one-number/vendor-jobs/intent";

describe("a vendor asking for work reads as a vendor", () => {
  it.each([
    "hey is there any available jobs in the area to do",
    "Any jobs available?",
    "are there any jobs near me",
    "got any work available",
    "looking for work",
    "I'm a plumber, any work near Ballard",
    "any gigs in my area",
    "jobs available in the area",
    "available work for cleaners",
    "I do cleaning in Seattle",
  ])("%s", (text) => {
    expect(inferSenderRole(text)).toBe("vendor");
  });

  it.each([
    "Is Room 3 still available?",
    "I just got a new job near Ballard, is the room available",
    "I work nights, is room 3 available",
    "is the room clean and available",
    "Do you have any rooms open",
    "is there a job or income requirement",
    "any work done on the house before move in",
  ])("%s is not a vendor", (text) => {
    expect(inferSenderRole(text)).not.toBe("vendor");
  });
});

describe("readVendorJobsAsk", () => {
  it("the captain's sentence: jobs, no trade, no named place", () => {
    const ask = readVendorJobsAsk("hey is there any available jobs in the area to do");
    expect(ask).toMatchObject({ vendorish: true, wantsJobs: true, trade: null, areaText: null, unknownArea: null });
  });

  it("a trade and a Seattle place", () => {
    const ask = readVendorJobsAsk("I'm a plumber, any work near Ballard");
    expect(ask).toMatchObject({ vendorish: true, trade: "plumbing", tradeLabel: "Plumbing" });
    expect(ask.areaText).toContain("Ballard");
  });

  it("a zip is a place", () => {
    expect(readVendorJobsAsk("cleaning jobs 98115").areaText).toContain("98115");
  });

  it("a place outside the table is named back, not guessed", () => {
    const ask = readVendorJobsAsk("any jobs in Tacoma");
    expect(ask.areaText).toBeNull();
    expect(ask.unknownArea).toBe("Tacoma");
  });

  it("'the area' is no place", () => {
    expect(readVendorJobsAsk("any jobs in the area").unknownArea).toBeNull();
  });

  it("asks for the sign-up link", () => {
    expect(readVendorJobsAsk("send me the link").wantsLink).toBe(true);
    expect(readVendorJobsAsk("how do I create an account").wantsLink).toBe(true);
  });

  it("a bare trade word is not a vendor (a clean room is not a cleaner)", () => {
    expect(readVendorJobsAsk("is the room clean").vendorish).toBe(false);
  });

  it("asksForJobs separates a question from a self description", () => {
    expect(asksForJobs("any jobs available")).toBe(true);
    expect(asksForJobs("looking for work in Seattle")).toBe(true);
    expect(asksForJobs("I do cleaning in Seattle")).toBe(false);
  });

  it("maps trades to the board's labels", () => {
    expect(tradeLabelFor("handyman")).toBe("General maintenance");
    expect(tradeLabelFor("hvac")).toBe("HVAC");
    expect(tradeLabelFor("roofing")).toBe("Other");
    expect(tradeLabelFor(null)).toBeNull();
  });
});

describe("a trade word alone", () => {
  it.each(["I do plumbing", "handyman here", "cleaner", "Plumber", "electrician in Ballard", "we are a cleaning company", "I need a quote"])("%s names a trade", (text) => {
    expect(readVendorJobsAsk(text).tradeSelfId).toBe(true);
  });
  it.each(["Is Room 3 available?", "is the room clean", "Do you have any rooms open", "can I tour tomorrow"])("%s does not", (text) => {
    expect(readVendorJobsAsk(text).tradeSelfId).toBe(false);
  });
});

describe("readVendorQuestion", () => {
  it.each([
    ["how does it work?", "how"],
    ["how do I get started", "how"],
    ["what is this", "how"],
    ["how do I get paid?", "pay"],
    ["when do I get paid", "pay"],
    ["how are payouts handled", "pay"],
    ["what areas do you cover", "areas"],
    ["where do you work", "areas"],
    ["is it free to join", "cost"],
  ] as const)("%s -> %s", (text, topic) => {
    expect(readVendorQuestion(text)).toBe(topic);
  });
  it("is null for a jobs ask or small talk", () => {
    expect(readVendorQuestion("any jobs available")).toBeNull();
    expect(readVendorQuestion("ok thanks")).toBeNull();
  });
});
