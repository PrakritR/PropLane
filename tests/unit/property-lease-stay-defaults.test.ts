import { describe, expect, it } from "vitest";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import {
  createPropertyLeaseTemplate,
  effectiveDefaultLeaseForStay,
  explicitDefaultLeaseForStay,
  leaseTemplateStay,
  readPropertyLeaseTemplates,
  withLeaseDefaultForStay,
  type PropertyLeaseTemplate,
} from "@/lib/property-lease-templates";
import { resolvePropertyLeaseTemplateForApplication } from "@/lib/property-lease-template-sync";

const make = (kind: PropertyLeaseTemplate["kind"], label: string, extra: Partial<PropertyLeaseTemplate> = {}): PropertyLeaseTemplate => ({
  ...createPropertyLeaseTemplate({ kind, label, source: "axis_default" }),
  ...extra,
});

describe("lease stay derivation", () => {
  it("reads the stay from kind, and from the routed terms for time-based and custom leases", () => {
    expect(leaseTemplateStay({ kind: "long-term" })).toBe("long_term");
    expect(leaseTemplateStay({ kind: "short-term" })).toBe("short_term");
    expect(leaseTemplateStay({ kind: "custom", applicationLeaseTerms: ["Short-Term Stay"] })).toBe("short_term");
    expect(leaseTemplateStay({ kind: "time-based", applicationLeaseTerms: ["Airbnb", "Short-Term Stay"] })).toBe("short_term");
    expect(leaseTemplateStay({ kind: "custom", applicationLeaseTerms: ["Short-Term Stay", "Long-term"] })).toBe("long_term");
    expect(leaseTemplateStay({ kind: "custom" })).toBe("long_term");
    expect(leaseTemplateStay({ kind: "time-based", applicationLeaseTerms: [] })).toBe("long_term");
  });
});

describe("lease defaultFor", () => {
  it("normalizes on read: unknown stays and repeats drop, an empty list is absent", () => {
    const row = make("long-term", "Primary");
    const sub = {
      ...createDefaultListingSubmission(),
      propertyLeaseTemplates: [
        { ...row, defaultFor: ["long_term", "long_term", "weekly"] },
        { ...make("short-term", "Short"), defaultFor: ["nope"] },
        { ...make("long-term", "Plain") },
      ],
    } as unknown as ReturnType<typeof createDefaultListingSubmission>;
    const [first, second, third] = readPropertyLeaseTemplates(sub);
    expect(first!.defaultFor).toEqual(["long_term"]);
    expect(second!.defaultFor).toBeUndefined();
    expect(third!.defaultFor).toBeUndefined();
  });

  it("explicit default is the offered lease of that stay that names it", () => {
    const long = make("long-term", "Long");
    const longB = make("long-term", "Long B", { defaultFor: ["long_term"] });
    const shortWrong = make("short-term", "Short", { defaultFor: ["long_term"] });
    const notOffered = make("long-term", "Hidden", { defaultFor: ["long_term"], offered: false });
    expect(explicitDefaultLeaseForStay([long, longB], "long_term")?.id).toBe(longB.id);
    expect(explicitDefaultLeaseForStay([long, longB], "short_term")).toBeNull();
    // A lease of the other stay never claims this stay's default; an unoffered lease never does either.
    expect(explicitDefaultLeaseForStay([shortWrong], "long_term")).toBeNull();
    expect(explicitDefaultLeaseForStay([notOffered], "long_term")).toBeNull();
  });

  it("effective default: explicit, else defaultLeaseTemplateId when it is of that stay, else the first of the stay", () => {
    const a = make("long-term", "A");
    const b = make("long-term", "B");
    const s = make("short-term", "S");
    expect(effectiveDefaultLeaseForStay([a, b, s], "long_term")?.id).toBe(a.id);
    expect(effectiveDefaultLeaseForStay([a, b, s], "long_term", b.id)?.id).toBe(b.id);
    // The fallback id of the other stay is ignored.
    expect(effectiveDefaultLeaseForStay([a, b, s], "short_term", b.id)?.id).toBe(s.id);
    const pinned = withLeaseDefaultForStay([a, b, s], a.id, "long_term");
    expect(effectiveDefaultLeaseForStay(pinned, "long_term", b.id)?.id).toBe(a.id);
    expect(effectiveDefaultLeaseForStay([], "short_term")).toBeNull();
  });

  it("withLeaseDefaultForStay moves the default and keeps the other stay's", () => {
    const a = make("long-term", "A", { defaultFor: ["long_term"] });
    const b = make("long-term", "B");
    const next = withLeaseDefaultForStay([a, b], b.id, "long_term");
    expect(next.find((row) => row.id === a.id)!.defaultFor).toBeUndefined();
    expect(next.find((row) => row.id === b.id)!.defaultFor).toEqual(["long_term"]);
  });
});

describe("lease routing", () => {
  const primary = make("long-term", "Primary", { listingSeedKey: "primary" });
  const premium = make("long-term", "Premium long term");
  const short = make("short-term", "Short stay", { listingSeedKey: "short-term" });
  const shortB = make("short-term", "Short stay B");
  const subFor = (leases: PropertyLeaseTemplate[]) => ({ ...createDefaultListingSubmission(), propertyLeaseTemplates: leases });
  const pick = (leases: PropertyLeaseTemplate[]) => ({
    long: resolvePropertyLeaseTemplateForApplication(subFor(leases), { leaseTerm: "12-Month" })?.id,
    longNoTerm: resolvePropertyLeaseTemplateForApplication(subFor(leases), {})?.id,
    short: resolvePropertyLeaseTemplateForApplication(subFor(leases), { rentalType: "short_term" })?.id,
    shortTerm: resolvePropertyLeaseTemplateForApplication(subFor(leases), { leaseTerm: "Short-Term Stay" })?.id,
  });

  it("is unchanged when no lease has an explicit defaultFor", () => {
    expect(pick([premium, primary, short, shortB])).toEqual({
      long: primary.id,
      longNoTerm: primary.id,
      short: short.id,
      shortTerm: short.id,
    });
  });

  it("an explicit defaultFor wins only for its own stay", () => {
    const longPinned = [premium, primary, short, shortB].map((row) => (row.id === premium.id ? { ...row, defaultFor: ["long_term" as const] } : row));
    expect(pick(longPinned)).toEqual({ long: premium.id, longNoTerm: premium.id, short: short.id, shortTerm: short.id });
    const shortPinned = [premium, primary, short, shortB].map((row) => (row.id === shortB.id ? { ...row, defaultFor: ["short_term" as const] } : row));
    expect(pick(shortPinned)).toEqual({ long: primary.id, longNoTerm: primary.id, short: shortB.id, shortTerm: shortB.id });
  });
});
