/**
 * Source guards for the owner portal (W21): it follows the same portal UI rules as the manager, resident and vendor portals.
 * No pills on rows, no subtext under a heading or row, no page title above a list or the Overview (the header card or the KPI
 * cards are the first thing), no sparkle chrome, and no icon-less nav row.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(process.cwd(), "src", "components", "owner");
const files = readdirSync(DIR).filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"));
const read = (f: string) => readFileSync(join(DIR, f), "utf8");

/** Screens that are a list or the dashboard: no title above them. Settings and a record page keep theirs. */
const LIST_SCREENS = ["owner-overview.tsx", "owner-properties.tsx", "owner-statements.tsx", "owner-documents.tsx", "owner-messages.tsx", "owner-finances.tsx"];

describe("owner portal draws no pills on rows", () => {
  for (const f of files) {
    it(`${f} has no Badge or status chip`, () => {
      const source = read(f);
      expect(source).not.toMatch(/<Badge\b/);
      expect(source).not.toMatch(/PortalRowStatusChip/);
    });
  }
});

describe("owner portal has no subtext and no list titles", () => {
  for (const f of LIST_SCREENS) {
    it(`${f} puts no page title above its content`, () => {
      const source = read(f);
      expect(source).not.toMatch(/<OwnerPageTitle\b/);
      expect(source).not.toMatch(/<h1\b/);
    });
  }
  for (const f of files) {
    it(`${f} passes no description or meta to the settings kit or a row`, () => {
      const source = read(f);
      expect(source).not.toMatch(/<Portal(Settings\w+|ServiceRecordRow|PropertyRecordRow)\b[^>]*?\b(description|meta)=/s);
    });
  }
});

describe("owner portal chrome", () => {
  it("draws no sparkle or assistant glyph anywhere in the owner components", () => {
    for (const f of files) expect(read(f), f).not.toMatch(/Sparkle|AxisAssistant|useAssistantLauncher/);
  });

  it("gives every nav row a real glyph and shows no page-title block in the shell", () => {
    const shell = read("owner-portal-shell.tsx");
    for (const id of ["overview", "properties", "money", "messages", "settings"]) expect(shell).toMatch(new RegExp(`\\b${id}:\\s*\\w+,`));
    expect(shell).not.toMatch(/\bCircle\b/);
  });

  it("reuses the shared shell classes rather than its own", () => {
    const shell = read("owner-portal-shell.tsx");
    expect(shell).toContain("PORTAL_SHELL_ROOT_CLASS");
    expect(shell).toContain("PORTAL_NATIVE_BOTTOM_NAV_CLASS");
    expect(shell).toContain('data-slot="portal-top-strip"');
    expect(shell).toContain('data-slot="portal-workspace-rail"');
    expect(shell).toContain('data-slot="portal-sidebar"');
  });

  it("uses icon-only header actions (the word is the tooltip) on the list headers", () => {
    for (const f of ["owner-statements.tsx", "owner-finances.tsx"]) expect(read(f), f).toContain("PortalIconAction");
  });
});
