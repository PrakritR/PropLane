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

describe("PRP-184 — chrome substrate wash darkens the center, not the edges", () => {
  const globalsCss = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");

  function washRule(theme: "dark" | "light"): string {
    const marker = theme === "dark" ? ".chrome-substrate-full__wash {" : '[data-theme="light"] .chrome-substrate-full__wash {';
    const start = globalsCss.indexOf(marker);
    expect(start, `${marker} should exist`).toBeGreaterThan(-1);
    const end = globalsCss.indexOf("}", start);
    return globalsCss.slice(start, end);
  }

  it.each(["dark", "light"] as const)("puts an opaque stop at 0%% and transparent further out, for %s theme", (theme) => {
    const rule = flat(washRule(theme));
    // A page's content sits at the ellipse's center (50% 50%), so the stop AT
    // 0% must be the opaque color and a later stop must be transparent — the
    // reverse (transparent at 0%, opaque further out) leaves centered content
    // riding the unmuted decorative layers underneath, which is the bug this
    // pins against regressing.
    const zeroPercentIsOpaque = /rgba\([^)]+\)\s*0%/.test(rule);
    const laterStopIsTransparent = /transparent\s*\d+%/.test(rule);
    expect(zeroPercentIsOpaque, `expected an opaque color at the 0% stop: ${rule}`).toBe(true);
    expect(laterStopIsTransparent, `expected a transparent stop past the center: ${rule}`).toBe(true);
  });
});

describe("PRP-184 — OpsSky tab strip holds contrast across the whole gradient", () => {
  const proplaneCss = readFileSync(
    path.join(process.cwd(), "src/components/marketing/landing-proplane.css"),
    "utf8",
  );

  it("gives .lp-controls an opaque-enough scrim behind the white-on-blue tabs", () => {
    // Plain rgba(255,255,255,0.78) text tops out around 3.2:1 against the
    // lightest gradient stop (--pl-blue-soft) with no scrim at all — a scrim
    // is required, not just a text-opacity bump, for every point in the
    // gradient the tab strip can land on.
    const start = proplaneCss.indexOf(".lp-controls {");
    const end = proplaneCss.indexOf("}", start);
    const rule = flat(proplaneCss.slice(start, end));
    expect(rule).toMatch(/background:\s*rgba\(0,\s*0,\s*0,\s*0\.(3|4|5|6)/);
  });
});

describe("PRP-184 #4 — scroll regions are keyboard-reachable", () => {
  const dashDemo = readFileSync(
    path.join(process.cwd(), "src/components/marketing/landing-dashboard-chat-demo.tsx"),
    "utf8",
  );
  const inboxDemo = readFileSync(
    path.join(process.cwd(), "src/components/marketing/landing-inbox-approve-demo.tsx"),
    "utf8",
  );
  const residents = readFileSync(path.join(process.cwd(), "src/components/portal/pro-residents.tsx"), "utf8");

  it("makes the dashboard demo's vertical and horizontal scroll regions tabbable", () => {
    expect(flat(dashDemo)).toMatch(/className="lp-dash-inner space-y-5" tabIndex=\{0\} role="region"/);
    expect(flat(dashDemo)).toMatch(/overflow-x-auto[^"]*"\s*tabIndex=\{0\}\s*role="region"/);
  });

  it("makes the inbox demo's message thread scroll region tabbable", () => {
    expect(inboxDemo).toContain('className="lp-ibx-thread-body" tabIndex={0} role="region"');
  });

  it("makes the resident-detail services table scroll region tabbable", () => {
    expect(flat(residents)).toMatch(/overflow-x-auto`\}\s*tabIndex=\{0\}\s*role="region"/);
  });
});
