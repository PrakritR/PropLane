// The Approve popup's message row: the manager's own words go above the standard setup email,
// and the account-setup link and PropLane ID stay in it.
import { describe, expect, it } from "vitest";
import {
  RESIDENT_WELCOME_NOTE_MAX_CHARS,
  buildResidentWelcomeEmailBody,
  buildResidentWelcomeEmailHtml,
  buildResidentWelcomeMailtoHref,
  cleanResidentWelcomeNote,
} from "@/lib/resident-welcome-email";

const base = { residentName: "Casey Morgan", axisId: "PROPLANE-ABCD1234", signupUrl: "https://example.test/auth/resident-setup?token=t" };

describe("welcome note", () => {
  it("is printed above the standard welcome, with the setup link still in the email", () => {
    const text = buildResidentWelcomeEmailBody({ ...base, managerNote: "Your application for Alder House is approved. I'll send your lease next." });
    expect(text.indexOf("Your application for Alder House is approved")).toBeLessThan(text.indexOf("Welcome to PropLane"));
    expect(text).toContain(base.signupUrl);
    expect(text).toContain("Hi Casey Morgan,");
  });

  it("changes nothing when there is no note", () => {
    expect(buildResidentWelcomeEmailBody(base)).toBe(buildResidentWelcomeEmailBody({ ...base, managerNote: "   " }));
  });

  it("is escaped in the HTML email", () => {
    const html = buildResidentWelcomeEmailHtml({ ...base, managerNote: "<script>alert(1)</script> & welcome" });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain(base.signupUrl.replace(/&/g, "&amp;"));
  });

  it("is cleaned: control characters dropped, blank runs collapsed, length capped", () => {
    expect(cleanResidentWelcomeNote("a\u0000b\r\n\r\n\r\n\r\nc")).toBe("ab\n\nc");
    expect(cleanResidentWelcomeNote("x".repeat(RESIDENT_WELCOME_NOTE_MAX_CHARS + 50))).toHaveLength(RESIDENT_WELCOME_NOTE_MAX_CHARS);
    expect(cleanResidentWelcomeNote(null)).toBe("");
  });

  it("rides along (shortened) in the mailto fallback", () => {
    const href = buildResidentWelcomeMailtoHref({ residentEmail: "casey@example.com", residentName: "Casey", axisId: base.axisId, origin: "", managerNote: "Welcome home" });
    expect(decodeURIComponent(href)).toContain("Welcome home");
  });
});
