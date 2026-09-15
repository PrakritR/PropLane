// The listing wizard carries labels and controls, never a line of small grey
// text under them (AGENTS.md → Portal UI system, "No small grey subtext").
// This reads the source so the rule fails the build the day a hint, subtitle,
// description or "optional" marker comes back.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "src/components/portal/listing-wizard-v2");
const files = readdirSync(DIR).filter((f) => f.endsWith(".tsx"));

const BANNED: Array<{ re: RegExp; why: string }> = [
  { re: /\bhint=/, why: "a field hint" },
  { re: /\bsubtitle="/, why: "a step subtitle" },
  { re: /\bdescription="/, why: "a section or option description" },
  { re: /\boptional(?=[\s>])/, why: 'an "optional" marker on a field' },
  { re: />optional</, why: 'an "optional" label' },
  { re: /text-muted">[A-Z][^<{]{24,}</, why: "a sentence of grey subtext" },
];

describe("the listing wizard has no small grey subtext", () => {
  for (const file of files) {
    it(file, () => {
      const src = readFileSync(join(DIR, file), "utf8");
      // Comments explain the code to developers; the rule is about what renders.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const { re, why } of BANNED) {
        const m = code.match(re);
        expect(m, `${file} renders ${why}: ${m?.[0]}`).toBeNull();
      }
    });
  }
});
