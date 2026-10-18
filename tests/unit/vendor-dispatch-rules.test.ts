/**
 * Dispatch rule validation + vendor role normalization (vendor-dispatch-1018, portal side).
 * Pure: the routes validate through `parseDispatchRuleInput`, the vendors route normalizes
 * every roster row through `normalizeVendorDispatchFields`.
 */
import { describe, expect, it } from "vitest";
import {
  defaultTimeoutForUrgencies,
  formatRulePay,
  parseDispatchRuleInput,
  ruleEffectiveTimeoutMinutes,
  type DispatchRuleInput,
} from "@/lib/vendor-dispatch/rules";
import {
  centsToDollarsInput,
  dollarsInputToCents,
  normalizeVendorDispatchFields,
  vendorDispatchRoles,
  vendorTakesRole,
} from "@/lib/vendor-dispatch/vendor-roles";

const valid = {
  name: "  Lockout   chain ",
  trade: "locksmith",
  issue: "lockout",
  propertyScope: "selected",
  propertyIds: ["h1", "h2", "h1"],
  urgencies: ["routine", "emergency"],
  hours: "any",
  mode: "sequential",
  broadcastSize: 3,
  timeoutMinutes: null,
  payCents: 12000,
  payModel: "flat",
  nteCents: 20000,
  vendorIds: ["v1", "v2", "v1"],
};

describe("parseDispatchRuleInput", () => {
  it("normalizes a valid rule: trimmed name, deduped houses and vendors, urgencies in canonical order", () => {
    const parsed = parseDispatchRuleInput(valid);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.name).toBe("Lockout chain");
    expect(parsed.value.propertyIds).toEqual(["h1", "h2"]);
    expect(parsed.value.vendorIds).toEqual(["v1", "v2"]);
    expect(parsed.value.urgencies).toEqual(["emergency", "routine"]);
    expect(parsed.value.active).toBe(true);
  });

  it("drops the house list for an all-houses rule", () => {
    const parsed = parseDispatchRuleInput({ ...valid, propertyScope: "all" });
    expect(parsed.ok && parsed.value.propertyIds).toEqual([]);
  });

  it.each([
    ["an unknown trade", { trade: "wizard" }],
    ["an issue outside the trade", { issue: "leak" }],
    ["a selected scope with no house", { propertyIds: [] }],
    ["no urgency", { urgencies: [] }],
    ["an unknown hours value", { hours: "weekends" }],
    ["an unknown mode", { mode: "everyone" }],
    ["a broadcast size of 1", { broadcastSize: 1 }],
    ["a broadcast size of 11", { broadcastSize: 11 }],
    ["a one-minute wait", { timeoutMinutes: 1 }],
    ["a wait over a day", { timeoutMinutes: 1441 }],
    ["a negative pay", { payCents: -5 }],
    ["a non-number pay", { payCents: "12" }],
    ["an unknown pay model", { payModel: "barter" }],
    ["an empty chain", { vendorIds: [] }],
    ["a blank name", { name: "   " }],
    ["a name over 80 characters", { name: "x".repeat(81) }],
  ])("refuses %s", (_label, patch) => {
    expect(parseDispatchRuleInput({ ...valid, ...patch }).ok).toBe(false);
  });

  it("refuses a chain longer than 20 vendors", () => {
    const vendorIds = Array.from({ length: 21 }, (_, i) => `v${i}`);
    expect(parseDispatchRuleInput({ ...valid, vendorIds }).ok).toBe(false);
  });

  it("fills missing keys from the stored rule on a partial update, and ignores unknown keys", () => {
    const base = (parseDispatchRuleInput(valid) as { ok: true; value: DispatchRuleInput }).value;
    const paused = parseDispatchRuleInput({ active: false, owner_user_id: "attacker", workspaceId: "w9" }, base);
    expect(paused.ok).toBe(true);
    if (!paused.ok) return;
    expect(paused.value.active).toBe(false);
    expect(paused.value.vendorIds).toEqual(base.vendorIds);
    expect(Object.keys(paused.value)).not.toContain("owner_user_id");
    expect(Object.keys(paused.value)).not.toContain("workspaceId");
  });

  it("refuses a body that is not an object", () => {
    expect(parseDispatchRuleInput(null).ok).toBe(false);
    expect(parseDispatchRuleInput([]).ok).toBe(false);
  });
});

describe("rule timing and pay words", () => {
  it("uses the rule's own wait, else the default for its most urgent urgency", () => {
    expect(ruleEffectiveTimeoutMinutes({ timeoutMinutes: 45, urgencies: ["routine"] })).toBe(45);
    expect(ruleEffectiveTimeoutMinutes({ timeoutMinutes: null, urgencies: ["routine", "urgent"] })).toBe(30);
    expect(defaultTimeoutForUrgencies(["emergency", "routine"])).toBe(10);
    expect(defaultTimeoutForUrgencies(["routine"])).toBe(120);
  });

  it("writes the pay figure by model", () => {
    expect(formatRulePay(12000, "flat")).toBe("$120");
    expect(formatRulePay(4550, "hourly")).toBe("$45.50/hr");
    expect(formatRulePay(3000, "per_room")).toBe("$30/room");
    expect(formatRulePay(null, "flat")).toBe("Quote");
    expect(formatRulePay(9900, "quote")).toBe("Quote");
  });
});

describe("normalizeVendorDispatchFields", () => {
  it("keeps valid roles, area, rate, license, insurance date and availability", () => {
    const out = normalizeVendorDispatchFields({
      dispatchTrades: ["locksmith", "plumber", "locksmith"],
      serviceArea: "  Capitol   Hill ",
      dispatchRateCents: 8500.4,
      dispatchPayModel: "hourly",
      insuranceExpiresAt: "2027-03-01",
      licenseNumber: " LIC-42 ",
      dispatchAvailable: false,
    });
    expect(out).toEqual({
      dispatchTrades: ["locksmith", "plumber"],
      serviceArea: "Capitol Hill",
      dispatchRateCents: 8500,
      dispatchPayModel: "hourly",
      insuranceExpiresAt: "2027-03-01",
      licenseNumber: "LIC-42",
      dispatchAvailable: false,
    });
  });

  it("strips unknown roles, bad numbers, impossible dates and wrong types", () => {
    const out = normalizeVendorDispatchFields({
      dispatchTrades: ["wizard", 7, null],
      serviceArea: 12,
      dispatchRateCents: -1,
      dispatchPayModel: "barter",
      insuranceExpiresAt: "2027-02-30",
      licenseNumber: { x: 1 },
      dispatchAvailable: "no",
    });
    expect(out).toEqual({
      dispatchTrades: undefined,
      serviceArea: undefined,
      dispatchRateCents: undefined,
      dispatchPayModel: undefined,
      insuranceExpiresAt: undefined,
      licenseNumber: undefined,
      dispatchAvailable: undefined,
    });
  });

  it("caps text lengths", () => {
    const out = normalizeVendorDispatchFields({ serviceArea: "a".repeat(500), licenseNumber: "b".repeat(500) });
    expect(out.serviceArea).toHaveLength(120);
    expect(out.licenseNumber).toHaveLength(60);
  });
});

describe("vendor roles", () => {
  it("maps legacy trade labels onto dispatch roles when none were set", () => {
    expect(vendorDispatchRoles({ trade: "Plumbing" })).toEqual(["plumber"]);
    expect(vendorDispatchRoles({ trade: "x", trades: ["Cleaning", "Electrical"] })).toEqual(["cleaner", "electrician"]);
    expect(vendorDispatchRoles({ trade: "Mystery" })).toEqual([]);
  });

  it("prefers explicit dispatch roles", () => {
    expect(vendorDispatchRoles({ trade: "Plumbing", dispatchTrades: ["locksmith"] })).toEqual(["locksmith"]);
  });

  it("takes a role only while active and available", () => {
    const base = { trade: "Plumbing", active: true };
    expect(vendorTakesRole(base, "plumber")).toBe(true);
    expect(vendorTakesRole(base, "locksmith")).toBe(false);
    expect(vendorTakesRole({ ...base, dispatchAvailable: false }, "plumber")).toBe(false);
    expect(vendorTakesRole({ ...base, active: false }, "plumber")).toBe(false);
    expect(vendorTakesRole(base, null)).toBe(true);
  });

  it("converts dollars to cents and back", () => {
    expect(dollarsInputToCents("$1,200.50")).toBe(120050);
    expect(dollarsInputToCents("")).toBeNull();
    expect(dollarsInputToCents("abc")).toBeNull();
    expect(centsToDollarsInput(12000)).toBe("120");
    expect(centsToDollarsInput(4550)).toBe("45.50");
    expect(centsToDollarsInput(null)).toBe("");
  });
});
