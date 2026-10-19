import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const homepageSources = [
  "src/app/(public)/page.tsx",
  "src/components/marketing/texting-home-hero.tsx",
  "src/components/marketing/home-number-stage.tsx",
  "src/components/layout/home-navbar.tsx",
];

describe("homepage copy restraint", () => {
  it.each(homepageSources)("keeps unsupported claims and decorative AI chrome out of %s", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source).not.toMatch(/\b(?:revolutionize|seamless|supercharge|unlock|empower|effortless|next-generation|cutting-edge)\b/i);
    expect(source).not.toMatch(/\b(?:Sparkles|WandSparkles|Stars)\b/);
    // "Book a demo" is the top bar's action by the captain's order (#26), so it is no longer on this list.
    expect(source).not.toMatch(/Open the demo|Most popular|AI-powered|ONE NUMBER\. EVERY CONVERSATION\./i);
  });
});
