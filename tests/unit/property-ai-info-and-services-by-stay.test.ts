import { describe, expect, it } from "vitest";
import {
  createDefaultListingSubmission,
  createManagerListingServiceOption,
  normalizeAiCommunicationCustom,
  normalizeAiCommunicationInfoShortTerm,
  normalizeManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { aiInfoForStay, aiInfoTextForStay, withShortTermText } from "@/lib/property-ai-info-by-stay";
import {
  missingServiceQuickAdds,
  serviceAppliesTo,
  serviceFromQuickAdd,
} from "@/lib/property-services-by-stay";
import { rowsInStay, stayTabsFor } from "@/lib/property-stay-tabs";

function subWith(over: Record<string, unknown>) {
  return normalizeManagerListingSubmissionV1({ ...createDefaultListingSubmission(), ...over } as never);
}

describe("service appliesTo", () => {
  it("normalization keeps appliesTo/billingCadence only when stored; absent stays absent", () => {
    const sub = subWith({
      serviceRequestOptions: [
        { id: "a", name: "Cleaning" },
        { id: "b", name: "Linen change", appliesTo: "short_term", billingCadence: "monthly" },
        { id: "c", name: "Storage", appliesTo: "nonsense" },
      ],
    });
    const [a, b, c] = sub.serviceRequestOptions!;
    expect("appliesTo" in a!).toBe(false);
    expect("billingCadence" in a!).toBe(false);
    expect(b!.appliesTo).toBe("short_term");
    expect(b!.billingCadence).toBe("monthly");
    expect("appliesTo" in c!).toBe(false);
    expect(serviceAppliesTo(a!)).toBe("both");
  });

  it("a both-stay (or absent) service is in both tab row sets; a single-stay one in its own", () => {
    const offers = [
      { ...createManagerListingServiceOption("Cleaning"), appliesTo: "both" as const },
      { ...createManagerListingServiceOption("Dusting") },
      { ...createManagerListingServiceOption("Parking"), appliesTo: "long_term" as const },
      { ...createManagerListingServiceOption("Linen"), appliesTo: "short_term" as const },
    ];
    const names = (stay: "long_term" | "short_term") => rowsInStay(offers, stay, (o) => o.appliesTo).map((o) => o.name);
    expect(names("long_term")).toEqual(["Cleaning", "Dusting", "Parking"]);
    expect(names("short_term")).toEqual(["Cleaning", "Dusting", "Linen"]);
  });

  it("the Short term tab is absent when the stay is not allowed, unless a short-term-only service exists", () => {
    const longOnly = createDefaultListingSubmission();
    expect(stayTabsFor(longOnly, { long_term: 0, short_term: 0 })).toEqual(["long_term"]);
    expect(stayTabsFor(longOnly, { long_term: 0, short_term: 1 })).toEqual(["long_term", "short_term"]);
  });

  it("quick add: both-natural presets are for both stays, the rest follow the open tab; offered ones drop out", () => {
    expect(serviceFromQuickAdd("cleaning", "short_term")!.appliesTo).toBe("both");
    expect(serviceFromQuickAdd("furnishing", "long_term")!.appliesTo).toBe("both");
    expect(serviceFromQuickAdd("linen-change", "short_term")!.appliesTo).toBe("short_term");
    expect(serviceFromQuickAdd("parking-spot", "long_term")!.appliesTo).toBe("long_term");
    expect(serviceFromQuickAdd("nope", "long_term")).toBeNull();
    const have = [createManagerListingServiceOption("cleaning")];
    expect(missingServiceQuickAdds(have).map((q) => q.label)).toEqual([
      "Linen change",
      "Parking spot",
      "Storage",
      "Early check-in",
      "Late checkout",
      "Furnishing",
    ]);
  });

  it("Quick add matches the presets against the OPEN tab's services only", () => {
    const longOnlyLinen = { ...createManagerListingServiceOption("Linen change"), appliesTo: "long_term" as const };
    const bothCleaning = { ...createManagerListingServiceOption("Cleaning"), appliesTo: "both" as const };
    const offers = [longOnlyLinen, bothCleaning];
    expect(missingServiceQuickAdds(offers, "long_term").map((q) => q.label)).not.toContain("Linen change");
    // The Short term tab lists no linen service, so its preset is still offered there.
    expect(missingServiceQuickAdds(offers, "short_term").map((q) => q.label)).toContain("Linen change");
    // A both-stays service is listed in both tabs, so its preset is offered in neither.
    expect(missingServiceQuickAdds(offers, "short_term").map((q) => q.label)).not.toContain("Cleaning");
  });
});

describe("aiCommunicationInfoShortTerm normalization", () => {
  it("keeps trimmed non-empty known keys; nothing left is absent", () => {
    expect(normalizeAiCommunicationInfoShortTerm({ tours: "  Check-in at 3pm ", rules: "  ", bogus: "x" })).toEqual({
      tours: "Check-in at 3pm",
    });
    expect(normalizeAiCommunicationInfoShortTerm({ rules: "" })).toBeUndefined();
    expect(normalizeAiCommunicationInfoShortTerm(undefined)).toBeUndefined();
  });

  it("rides the listing submission; absent stays absent", () => {
    expect(subWith({ aiCommunicationInfoShortTerm: { about: "Nightly stays." } }).aiCommunicationInfoShortTerm).toEqual({
      about: "Nightly stays.",
    });
    expect(subWith({}).aiCommunicationInfoShortTerm).toBeUndefined();
  });

  it("custom items keep appliesTo only when valid", () => {
    expect(
      normalizeAiCommunicationCustom([
        { id: "1", title: "Wifi", text: "x", group: "home" },
        { id: "2", title: "Late checkout", text: "y", group: "rules", appliesTo: "short_term" },
        { id: "3", title: "Bad", text: "z", group: "rules", appliesTo: "monthly" },
      ]),
    ).toEqual([
      { id: "1", title: "Wifi", text: "x", group: "home" },
      { id: "2", title: "Late checkout", text: "y", group: "rules", appliesTo: "short_term" },
      { id: "3", title: "Bad", text: "z", group: "rules" },
    ]);
  });

  it("withShortTermText sets, replaces and removes one row; empty map reads as absent", () => {
    expect(withShortTermText(undefined, "tours", " Self check-in ")).toEqual({ tours: "Self check-in" });
    expect(withShortTermText({ tours: "a", rules: "b" }, "tours", "")).toEqual({ rules: "b" });
    expect(withShortTermText({ tours: "a" }, "tours", "  ")).toBeUndefined();
  });
});

describe("AI info by prospect stay", () => {
  const source = {
    marketingNotes: "A quiet craftsman.",
    aiCommunicationInfo: { tours: "Tours Saturdays.", rules: "No smoking.", pricing: "$1,200 a month.", neighborhood: "" },
    aiCommunicationInfoShortTerm: { pricing: "$95 a night.", about: "Furnished for short stays." },
    aiCommunicationCustom: [
      { id: "c1", title: "Parking", text: "One spot.", group: "area" as const },
      { id: "c2", title: "Lease break", text: "60 days notice.", group: "leasing" as const, appliesTo: "long_term" as const },
      { id: "c3", title: "Linen", text: "Weekly.", group: "home" as const, appliesTo: "short_term" as const },
    ],
  };

  it("a short-term prospect gets the short-term text when there is one, else the shared text", () => {
    const { sections } = aiInfoForStay(source, "short_term");
    expect(sections.pricing).toBe("$95 a night.");
    expect(sections.about).toBe("Furnished for short stays.");
    expect(sections.tours).toBe("Tours Saturdays.");
  });

  it("a long-term prospect never sees short-term text", () => {
    const { sections, custom } = aiInfoForStay(source, "long_term");
    expect(sections.pricing).toBe("$1,200 a month.");
    expect(sections.about).toBe("A quiet craftsman.");
    expect(JSON.stringify({ sections, custom })).not.toMatch(/\$95|Furnished for short|Linen|Weekly/);
  });

  it("an unknown stay shows shared and short-term text, both labelled", () => {
    const { sections } = aiInfoForStay(source, null);
    expect(sections.pricing).toBe("Shared: $1,200 a month.\nShort term: $95 a night.");
    // No override: just the shared text, unlabelled.
    expect(sections.rules).toBe("No smoking.");
    expect(aiInfoTextForStay("", "Self check-in", null)).toBe("Short term: Self check-in");
  });

  it("custom items are filtered by appliesTo; absent means both; unknown stay labels single-stay items", () => {
    const titles = (stay: "long_term" | "short_term" | null) => aiInfoForStay(source, stay).custom.map((c) => c.title);
    expect(titles("long_term")).toEqual(["Parking", "Lease break"]);
    expect(titles("short_term")).toEqual(["Parking", "Linen"]);
    const unknown = aiInfoForStay(source, null).custom;
    expect(unknown.map((c) => c.text)).toEqual(["One spot.", "Long term: 60 days notice.", "Short term: Weekly."]);
  });

  it("an empty source is empty", () => {
    expect(aiInfoForStay(undefined, "short_term")).toEqual({ sections: {}, custom: [] });
  });
});
