import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * PLAN-0924-1421 closed every public guest CTA. These three prompt components
 * must not reintroduce Continue-as-guest / continue-guest data-attrs.
 */
const PROMPT_FILES = [
  "src/components/marketing/public-apply-account-prompt.tsx",
  "src/components/marketing/prospect-action-account-gate.tsx",
  "src/components/marketing/signed-in-resident-account-prompt.tsx",
] as const;

const FORBIDDEN = [
  "public-apply-continue-guest",
  "prospect-apply-continue-guest",
  "prospect-tour-continue-guest",
  "prospect-message-continue-guest",
  "prospect-lease-continue-guest",
  "Continue as guest",
  "Continue without an account",
  "Schedule as a guest",
  "schedule as a guest",
  "continue as a guest",
] as const;

describe("public guest continue removed (PLAN-0924-1421)", () => {
  for (const rel of PROMPT_FILES) {
    it(`${rel} has no guest CTA strings or data-attrs`, () => {
      const src = readFileSync(path.join(process.cwd(), rel), "utf8");
      for (const needle of FORBIDDEN) {
        expect(src, `${rel} must not contain ${JSON.stringify(needle)}`).not.toContain(needle);
      }
    });
  }
});
