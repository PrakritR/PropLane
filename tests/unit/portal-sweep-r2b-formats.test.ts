import { describe, expect, it } from "vitest";
import { formatUsPhoneDisplay } from "@/lib/phone-e164";
import { formatPortalMonth, formatPortalRowDate } from "@/lib/portal-display-dates";
import { workspacePlanTierLabel } from "@/lib/workspaces/types";

describe("portal sweep r2 B6/B8 formats", () => {
  it("shows a stored plan tier by its display name", () => {
    expect(workspacePlanTierLabel("pro")).toBe("Pro");
    expect(workspacePlanTierLabel("business")).toBe("Business");
    expect(workspacePlanTierLabel("free")).toBe("Free");
    expect(workspacePlanTierLabel(null)).toBe("");
    expect(workspacePlanTierLabel("enterprise")).toBe("Enterprise");
  });

  it("formats a US vendor phone without the +1, and leaves other numbers alone", () => {
    expect(formatUsPhoneDisplay("+14255550147")).toBe("(425) 555-0147");
    expect(formatUsPhoneDisplay("4255550147")).toBe("(425) 555-0147");
    expect(formatUsPhoneDisplay("1 (425) 555-0147")).toBe("(425) 555-0147");
    expect(formatUsPhoneDisplay("+442071838750")).toBe("+442071838750");
    expect(formatUsPhoneDisplay("")).toBe("");
    expect(formatUsPhoneDisplay(null)).toBe("");
  });

  it("formats a billing month and a wall date the way people read them", () => {
    expect(formatPortalMonth("2026-11")).toBe("Nov 2026");
    expect(formatPortalMonth("2026-13")).toBe("2026-13");
    expect(formatPortalMonth(undefined)).toBe("");
    const now = Date.parse("2026-10-12T12:00:00Z");
    expect(formatPortalRowDate("2026-10-22", now)).toBe("Oct 22");
  });
});
