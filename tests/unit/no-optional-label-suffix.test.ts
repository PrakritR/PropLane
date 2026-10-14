/**
 * Source guard (AGENTS.md "Never generate subtext", round 7 of the portal sweep): a field label never
 * ends "(optional)". Required fields carry a mark; an optional one is simply unmarked. A placeholder
 * may still say what the field is for, so lines that are `placeholder` text are not label text.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const COMPONENTS = join(ROOT, "src", "components");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.tsx$/.test(name) ? [full] : [];
  });
}

/**
 * Surfaces outside the portal pop-up sweep (public booking, sign-up, partner, admin and vendor-guide forms)
 * that still carry the suffix. Remove a file from this list when its labels are cleaned; never add one.
 */
const NOT_YET_SWEPT = new Set([
  "src/components/portal/vendor-marketplace-guide.tsx",
  "src/components/portal/admin-test-workspaces-client.tsx",
  "src/components/auth/manager-entry-plan-chooser.tsx",
  "src/components/auth/manager-onboarding-inline-setup.tsx",
  "src/components/partner/partner-meeting-scheduler.tsx",
  "src/components/marketing/short-stay-booking.tsx",
  "src/components/marketing/rental-wizard-steps.tsx",
  "src/components/marketing/tour-schedule-flow.tsx",
  "src/components/rental-application/custom-question-field.tsx",
]);

describe("no field label ends (optional)", () => {
  it("no component prints (optional) as label text", () => {
    const offenders: string[] = [];
    for (const path of walk(COMPONENTS)) {
      const file = relative(ROOT, path);
      if (NOT_YET_SWEPT.has(file)) continue;
      let inBlockComment = false;
      readFileSync(path, "utf8").split("\n").forEach((line, index) => {
        const trimmed = line.trim();
        if (inBlockComment) {
          if (trimmed.includes("*/")) inBlockComment = false;
          return;
        }
        if (trimmed.startsWith("/*")) {
          if (!trimmed.includes("*/")) inBlockComment = true;
          return;
        }
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        if (/placeholder/i.test(line)) return;
        if (/\(optional\)/i.test(line)) offenders.push(`${file}:${index + 1}  ${trimmed.slice(0, 100)}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
