import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * PRP-325: a prospect must be able to be SHOWN how their data is protected,
 * and what they are shown must stay inside the claims the team can stand
 * behind. `docs/security/customer-security-wording.md` bounds those claims and
 * names the phrases that must never appear ("100% secure", "hack-proof",
 * "end-to-end encrypted", "zero knowledge", a breach being impossible).
 */
const PAGE = "src/app/(public)/security/page.tsx";

describe("public /security page (PRP-325)", () => {
  it("exists as a public route", () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  const source = readFileSync(PAGE, "utf8");

  it("carries the four supported protections from the wording doc", () => {
    expect(source).toContain("Encrypted connections and storage");
    expect(source).toContain("An additional layer for sensitive information");
    expect(source).toContain("Controlled access");
    expect(source).toContain("Ongoing security checks");
    // The bounded scope words the wording doc insists on.
    expect(source).toMatch(/Selected applicant and co-signer identity fields/);
    expect(source).toMatch(/application-uploaded documents/);
  });

  it("states the limits instead of overstating", () => {
    expect(source).toContain("What this does not mean");
    expect(source).toMatch(/not an independent audit, penetration test, SOC 2 report or HIPAA assessment/);
  });

  it("never uses a forbidden claim", () => {
    const lower = source.toLowerCase();
    for (const banned of [
      "100% secure",
      "hack-proof",
      "hackproof",
      "end-to-end encrypt",
      "zero knowledge",
      "zero-knowledge",
      "impossible to breach",
      "cannot be breached",
      "unhackable",
    ]) {
      expect(lower, `page must not claim "${banned}"`).not.toContain(banned);
    }
  });

  it("is linked from the public footer", () => {
    const footer = readFileSync("src/components/layout/public-footer.tsx", "utf8");
    expect(footer).toContain('href: "/security"');
  });
});
