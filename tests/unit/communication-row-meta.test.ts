import { describe, expect, it } from "vitest";
import { inboxRowAddressLabel, inboxThreadCategoryLabel } from "@/lib/communication-row-meta";

describe("inboxRowAddressLabel", () => {
  it("keeps a street line and trims the room off a composite label", () => {
    expect(inboxRowAddressLabel("4709A 8th Ave NE")).toBe("4709A 8th Ave NE");
    expect(inboxRowAddressLabel("4709A 8th Ave NE · Room 2")).toBe("4709A 8th Ave NE");
    expect(inboxRowAddressLabel("812 Roosevelt Way NE, Seattle, WA")).toBe("812 Roosevelt Way NE");
    expect(inboxRowAddressLabel("Cedar Flat 2B")).toBe("Cedar Flat 2B");
  });

  it("shows nothing rather than a machine id", () => {
    // A lease row with no human label falls back to the property id. Printed
    // verbatim under a conversation it reads as a bug, not as a house.
    expect(inboxRowAddressLabel("mgr-demo-lakeview")).toBeUndefined();
    expect(inboxRowAddressLabel("mgr_seed_4709a")).toBeUndefined();
    expect(inboxRowAddressLabel("3f8a1c2b-4d5e-4f60-9a7b-0c1d2e3f4a5b")).toBeUndefined();
    expect(inboxRowAddressLabel("")).toBeUndefined();
    expect(inboxRowAddressLabel(null)).toBeUndefined();
  });

  it("keeps a one-word label, which is likelier a building than an id", () => {
    expect(inboxRowAddressLabel("Lakeview")).toBe("Lakeview");
  });
});

describe("inboxThreadCategoryLabel", () => {
  it("labels only the categories the send path records", () => {
    expect(inboxThreadCategoryLabel({ category: "payments" })).toBe("Payments");
    expect(inboxThreadCategoryLabel({ category: "maintenance" })).toBe("Maintenance");
    expect(inboxThreadCategoryLabel({ category: "applications" })).toBe("Application");
  });

  it("shows no chip for the generic bucket, an unknown value, or no value", () => {
    // "messages" says nothing a reader does not know from being in an inbox.
    expect(inboxThreadCategoryLabel({ category: "messages" })).toBeUndefined();
    expect(inboxThreadCategoryLabel({ category: "something-new" })).toBeUndefined();
    expect(inboxThreadCategoryLabel({})).toBeUndefined();
  });
});
