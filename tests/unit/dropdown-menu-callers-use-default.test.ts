/**
 * @vitest-environment node
 *
 * No menu opts back out of the liquid default. The single allowed
 * `backdrop={false}` is the application-question menu that lives inside a
 * full-page modal (its overlay is the blur); `glass={false}` is never used.
 */
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("dropdown menus keep the liquid default", () => {
  it("only the in-modal question menu turns the backdrop off, and nothing turns glass off", () => {
    const out = execSync(
      `grep -rn --include='*.tsx' -E 'backdrop=\\{false\\}|glass=\\{false\\}' src || true`,
      { encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(out.map((l) => l.replace(/:\d+:.*$/, ""))).toEqual([
      "src/components/portal/application-form-builder.tsx",
    ]);
    expect(out.some((l) => l.includes("glass={false}"))).toBe(false);
  });
});
