import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isUnsafeRedirectPath } from "@/lib/auth/normalize-post-auth-path";

describe("guest client redirects reject protocol-relative paths", () => {
  it("the shared helper refuses // and /\\ paths", () => {
    expect(isUnsafeRedirectPath("//evil.com")).toBe(true);
    expect(isUnsafeRedirectPath("/\\evil.com")).toBe(true);
    expect(isUnsafeRedirectPath("/resident/applications")).toBe(false);
  });

  it("both guest forms gate a server-supplied path through it before navigating", () => {
    for (const file of ["src/components/marketing/guest-application-verify.tsx", "src/components/public/personal-account-form.tsx"]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).toContain("isUnsafeRedirectPath");
      expect(source, file).not.toMatch(/\.(next|nextPath)\.startsWith\("\/"\)/);
    }
  });
});
