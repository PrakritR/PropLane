import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const flat = (s: string) => s.replace(/\s+/g, " ");

describe("PRP-184 cursor-1 slice — resident dashboard nested interactives", () => {
  const dashboard = readFileSync(
    path.join(process.cwd(), "src/components/portal/resident-dashboard.tsx"),
    "utf8",
  );

  it("does not nest a link inside the attention-group toggle control", () => {
    expect(dashboard).not.toMatch(/role="button"[\s\S]*resident-dashboard-attention-link/);
    expect(dashboard).toMatch(/<button[\s\S]*resident-dashboard-attention-toggle/);
    expect(dashboard).toMatch(/<Link[\s\S]*resident-dashboard-attention-link/);
  });
});

describe("PRP-184 cursor-1 slice — public home + sign-in contrast hooks", () => {
  const globalsCss = flat(readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8"));
  const proplaneCss = flat(
    readFileSync(path.join(process.cwd(), "src/components/marketing/landing-proplane.css"), "utf8"),
  );
  const dashDemo = readFileSync(
    path.join(process.cwd(), "src/components/marketing/landing-dashboard-chat-demo.tsx"),
    "utf8",
  );

  it("keeps a legibility wash on the marketing hero text column", () => {
    expect(globalsCss).toContain(".landing-hero-wash");
    expect(globalsCss).toContain(".landing-hero-sub");
    expect(globalsCss).toContain(".landing-hero-trust");
  });

  it("bumps muted marketing list marks off transparent-only mixes", () => {
    expect(proplaneCss).toContain(".lp-page-list .lp-mark-muted");
    expect(proplaneCss).not.toContain("var(--lp-muted) 55%, transparent");
    expect(proplaneCss).toContain("var(--lp-ink) 55%, var(--lp-muted)");
  });

  it("raises web auth muted copy on the chrome substrate", () => {
    expect(globalsCss).toContain("html:not([data-native]) .auth-layout .auth-page-subtitle");
    expect(globalsCss).toContain("var(--pl-white) 92%, var(--pl-muted-fg)");
  });

  it("does not emit prohibited aria-hidden=false on the home dashboard demo", () => {
    expect(dashDemo).not.toContain('aria-hidden={false}');
  });
});
