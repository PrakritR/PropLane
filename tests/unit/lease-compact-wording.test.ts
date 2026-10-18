import { describe, expect, it } from "vitest";
import { compactPremisesAccessParagraph } from "@/lib/lease-templates/build-compact-room-lease-html";
import { readFileSync } from "node:fs";
import {
  CALIFORNIA_LEASE_CONFIG,
  DEPOSIT_RETURN_WITHOUT_VERIFIED_WINDOW,
  WASHINGTON_LEASE_CONFIG,
} from "@/lib/lease-templates/types";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

describe("room lease wording", () => {
  it("says the floor once", () => {
    const text = compactPremisesAccessParagraph({ floor: "2nd floor" }, "", esc);
    expect(text).toContain("their room on the 2nd floor.");
    expect(text).not.toMatch(/floor floor/i);
    expect(compactPremisesAccessParagraph({ floor: "2nd" }, "", esc)).toContain("on the 2nd floor.");
    expect(compactPremisesAccessParagraph({ floor: "Main" }, "", esc)).toContain("on the Main floor.");
    expect(compactPremisesAccessParagraph(undefined, "", esc)).toContain("exclusive use of their private room.");
  });

  it("gives the bathroom arrangement its own sentence, with no stray comma or doubled period", () => {
    const text = compactPremisesAccessParagraph({ floor: "2nd floor" }, "shared with Room 2 (shared), Room 3.", esc);
    expect(text).toContain("Bathroom access: shared with Room 2 (shared), Room 3.");
    expect(text).not.toContain("Room 3.,");
    expect(text).not.toContain("..");
    expect(text).toContain("Resident shall also have shared, non-exclusive use of the kitchen");
    expect(compactPremisesAccessParagraph({}, "bath assigned to this room", esc)).toContain("only the bathroom assigned to their room.");
  });
});

describe("the move-in condition report is a hand-filled printable", () => {
  it.each(["build-compact-room-lease-html.ts", "build-lease-html.ts"])("%s keeps its signature and date lines", (file) => {
    const source = readFileSync(`src/lib/lease-templates/${file}`, "utf8");
    const addendum = source.slice(source.indexOf("The completed condition report requires both parties"));
    expect(addendum).toContain("Landlord signature: ____________________ Date: __________");
    expect(addendum).toContain("Resident signature: ____________________ Date: __________");
  });
});

describe("the deposit-return paragraph is owned by the jurisdiction module", () => {
  it.each(["build-compact-room-lease-html.ts", "build-lease-html.ts"])("%s authors no deposit obligation of its own", (file) => {
    const source = readFileSync(`src/lib/lease-templates/${file}`, "utf8");
    expect(source).not.toContain("Landlord shall return any refundable portion");
    expect(source).toContain("DEPOSIT_RETURN_WITHOUT_VERIFIED_WINDOW");
  });

  it("Washington's window is a complete sentence and the fallback asserts no figure", () => {
    expect(WASHINGTON_LEASE_CONFIG.depositReturnWindow).toContain("Within 30 days");
    expect(WASHINGTON_LEASE_CONFIG.depositReturnWindow).toContain("written itemized statement of deductions");
    expect(WASHINGTON_LEASE_CONFIG.depositReturnWindow?.trim().endsWith(".")).toBe(true);
    // No verified figure for California, so the sentence names no number of days and no statute.
    expect(CALIFORNIA_LEASE_CONFIG.depositReturnWindow).toBeUndefined();
    expect(DEPOSIT_RETURN_WITHOUT_VERIFIED_WINDOW).not.toMatch(/\d/);
    expect(DEPOSIT_RETURN_WITHOUT_VERIFIED_WINDOW).not.toMatch(/RCW|Civil Code/);
  });
});
