/**
 * AXI-152 / AXI-126 — "since i clicked manager/vendor/residnet while signing up
 * it should not ask which account i want" / "when application tour link etc is
 * sent and a residnet is trying to sign up they should not have to choose".
 *
 * The email signup path already provisions a role handed in on `?role=` and
 * skips the chooser. The chooser page itself did not, so anything that landed
 * there WITH a role still asked again.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(path.join(process.cwd(), "src/app/auth/get-started/page.tsx"), "utf8");
const block = page.split("const autoChoseRef")[1]?.split("const signOut")[0] ?? "";

describe("get-started honours a role it was handed", () => {
  it("auto-selects from the role query param", () => {
    expect(block).toContain('searchParams.get("role")');
    expect(block).toContain("void choose(requested)");
  });

  it("only honours a role this chooser would actually offer", () => {
    // In add-portal mode the options are the roles the account does NOT hold, so
    // a param naming one it already has must be ignored, not re-provisioned.
    expect(block).toContain("pickerOptions.some((opt) => opt.id === requested)");
  });

  it("runs once — a re-render or a failed provision must not loop", () => {
    expect(block).toContain("autoChoseRef.current");
  });

  it("waits until the options and busy state have settled", () => {
    expect(block).toContain("resolving");
    expect(block).toContain("busy");
  });

  it("leaves the manual chooser intact for everyone else", () => {
    expect(page).toContain("onSelect={choose}");
  });
});
