import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("auth shell wears the homepage look (concept A)", () => {
  const shell = read("src/components/auth/auth-split-shell.tsx");
  const panel = read("src/components/auth/auth-brand-panel.tsx");
  const css = read("src/components/auth/auth-split.css");

  it("is one face: the root carries ps and the Inter Tight variable, never the display face", () => {
    expect(shell).toContain("publicSiteFont.variable");
    expect(shell).toMatch(/auth-layout ps /);
    expect(shell).not.toContain("siteDisplayFont");
  });

  it("never carries the PropLane number (the website channel; only the homepage shows the line)", () => {
    expect(shell).not.toContain("getPublicTextingConfig");
    expect(panel).not.toContain("phone: string | null");
    expect(panel).not.toMatch(/\(\d{3}\)\s?\d{3}-\d{4}|\+1\d{10}/);
  });

  it("has no sparkle, prompt bar, role chips or glass in the panel", () => {
    expect(panel).not.toMatch(/spark|prompt-bar|auth-hint|backdrop-filter|blur/i);
    expect(css).not.toMatch(/auth-prompt|auth-hint|backdrop-filter:\s*blur/);
  });

  it("makes the panel flush: full height, no radius, no inset", () => {
    const rule = css.match(/\.auth-brand-panel \{[^}]*height: 100dvh;[^}]*\}/s)?.[0] ?? "";
    expect(rule).toContain("padding: 0;");
    expect(rule).toContain("border-radius: 0;");
    expect(rule).toContain("margin: 0;");
  });
});
