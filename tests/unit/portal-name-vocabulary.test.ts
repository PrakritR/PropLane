import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The manager's portal is called the "Property portal" everywhere a person
 * reads it (captain, round #20). Schema names, routes (`/portal/...`), code
 * identifiers (`managerPortal`, `PortalKind "manager"`), analytics events and
 * comments keep the old word; so does the PERSON noun ("your manager",
 * "Message manager", "property manager").
 *
 * This scan is the guard on that split. It strips comments, then looks at
 * what is left (quoted strings and JSX text) for the retired portal name.
 * Identifiers never contain a space, so they cannot match.
 */
function walk(dir: string, exts: string[]): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path, exts);
    return exts.some((ext) => path.endsWith(ext)) ? [path] : [];
  });
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

const RETIRED = /manager(?:'s|’s)?\s+portal|switch\s+to\s+manager\b/i;

function offendersIn(files: string[], strip: boolean): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    const code = strip ? stripComments(raw) : raw;
    const match = RETIRED.exec(code);
    if (!match) continue;
    const line = code.slice(0, match.index).split("\n").length;
    offenders.push(`${file}:${line} ${code.split("\n")[line - 1]?.trim().slice(0, 100)}`);
  }
  return offenders;
}

describe("portal name vocabulary", () => {
  it("never calls the manager's portal the Manager portal in user-facing source", () => {
    const files = walk("src", [".ts", ".tsx"]);
    expect(offendersIn(files, true)).toEqual([]);
  });

  it("never calls it the Manager portal in the App Store listing", () => {
    const files = walk("app-store", [".json", ".md", ".txt"]);
    expect(offendersIn(files, false)).toEqual([]);
  });

  it("the portal switcher labels the manager portal the Property portal", async () => {
    const { portalSwitchTargets } = await import("@/lib/portal-switch-targets");
    expect(portalSwitchTargets("resident", ["manager", "resident"]).map((t) => t.label)).toEqual(["Switch to Property portal"]);
  });
});
