import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { normalizeAuthEmail } from "@/lib/auth/normalize-auth-email";

/**
 * Email local-parts are case-SENSITIVE to the auth provider, so `Manager@…` and
 * `manager@…` are two different accounts. Signup already stored lowercase, so
 * only sign-in produced the mismatch — and it produced it as "Invalid login
 * credentials", the wrong-password error, for an account the person owns
 * (PRP-196). iOS and macOS autocapitalise the first letter by default, so this
 * is the ordinary case on a phone.
 */
describe("normalizeAuthEmail", () => {
  it("lowercases and trims, so a mixed-case sign-in matches a lowercase account", () => {
    expect(normalizeAuthEmail("  Manager@Test.ProPlane.local ")).toBe("manager@test.proplane.local");
  });

  it("survives an absent value rather than throwing at a sign-in call site", () => {
    expect(normalizeAuthEmail(null)).toBe("");
    expect(normalizeAuthEmail(undefined)).toBe("");
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const AUTH_SOURCES = [
  ...walk(join(process.cwd(), "src/components/auth")),
  ...walk(join(process.cwd(), "src/app/auth")),
  join(process.cwd(), "src/components/portal/portal-change-password-panel.tsx"),
].filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"));

describe("every auth call site normalizes the address it hands the provider", () => {
  it("no signInWithPassword passes a raw or merely-trimmed email", () => {
    const offenders: string[] = [];
    for (const file of AUTH_SOURCES) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/signInWithPassword\(\{[^}]*\}/gs)) {
        const call = match[0];
        if (!/email:\s*normalizeAuthEmail\(/.test(call)) {
          offenders.push(`${file.replace(process.cwd() + "/", "")}: ${call.slice(0, 90).replace(/\s+/g, " ")}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("email inputs do not let a mobile keyboard capitalise the address", () => {
    const offenders: string[] = [];
    for (const file of AUTH_SOURCES) {
      const source = readFileSync(file, "utf8");
      const emailInputs = [...source.matchAll(/autoComplete="email"/g)].length;
      if (emailInputs === 0) continue;
      const guarded = [...source.matchAll(/autoCapitalize="none"/g)].length;
      if (guarded < emailInputs) {
        offenders.push(`${file.replace(process.cwd() + "/", "")}: ${emailInputs} email inputs, ${guarded} guarded`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
