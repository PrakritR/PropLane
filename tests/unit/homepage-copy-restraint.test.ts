import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const homepageSources = [
  "src/app/(public)/page.tsx",
  "src/components/marketing/texting-home-hero.tsx",
  "src/components/marketing/home-number-stage.tsx",
  "src/components/marketing/home-dashboard-stage.tsx",
  "src/components/marketing/home-dashboard-data.ts",
  "src/components/layout/home-navbar.tsx",
];

describe("homepage copy restraint", () => {
  it.each(homepageSources)("keeps unsupported claims and decorative AI chrome out of %s", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source).not.toMatch(/\b(?:revolutionize|seamless|supercharge|unlock|empower|effortless|next-generation|cutting-edge)\b/i);
    expect(source).not.toMatch(/\b(?:Sparkles|WandSparkles|Stars)\b/);
    expect(source).not.toMatch(/Open the demo|Book a demo|Most popular|AI-powered|ONE NUMBER\. EVERY CONVERSATION\./i);
  });
});
