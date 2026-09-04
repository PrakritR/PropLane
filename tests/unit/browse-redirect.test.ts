import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { routeResolves } from "../helpers/route-resolves";

/**
 * `next.config.ts` redirects outrank the app router (AGENTS.md → "Portal routing
 * precedence"), and NOTHING validates them: a destination that names no route
 * 404s at runtime with no build error, and the previous version of this file
 * asserted a literal substring of the config — a string the same commit had
 * just written — so it passed while `/browse/<anything>` was dead.
 *
 * That is exactly the failure `tests/unit/claw-resident-links.test.ts` was
 * written for on the link-builder side: assert a path RESOLVES, never that it
 * equals a string you also wrote.
 */

type Redirect = { source: string; destination: string };

function redirects(): Redirect[] {
  const config = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
  const out: Redirect[] = [];
  const re = /\{\s*source:\s*"([^"]+)",\s*destination:\s*"([^"]+)"/g;
  for (const match of config.matchAll(re)) {
    out.push({ source: match[1]!, destination: match[2]! });
  }
  return out;
}

/** `:param` / `:path*` stand-ins, so a dynamic destination is checked as a shape. */
function concreteDestination(destination: string): string {
  return destination
    .replace(/:[A-Za-z_]+\*/g, "x/y")
    .replace(/:[A-Za-z_]+/g, "x");
}

describe("next.config.ts redirects", () => {
  const all = redirects();

  it("finds the redirect table at all", () => {
    // Guards against the regex silently matching nothing, which would make
    // every assertion below vacuously true.
    expect(all.length).toBeGreaterThan(20);
  });

  it("redirects legacy /browse to the public browse page", () => {
    const root = all.find((r) => r.source === "/browse");
    expect(root?.destination).toBe("/rent/browse");
  });

  it("sends /browse sub-paths to the page that exists, not a sub-route that does not", () => {
    // `/rent/browse` is a single page.tsx — there is no `/rent/browse/[…]`, so
    // `destination: "/rent/browse/:path*"` 404s for every /browse/<x> link.
    const sub = all.find((r) => r.source === "/browse/:path*");
    expect(sub?.destination).toBe("/rent/browse");
    expect(routeResolves("/rent/browse/anything")).toBe(false);
  });

  it("every redirect destination resolves to a real route", () => {
    const dead = all
      .map((r) => ({ ...r, resolved: concreteDestination(r.destination) }))
      .filter((r) => r.destination.startsWith("/"))
      .filter((r) => !routeResolves(r.resolved));
    expect(dead.map((r) => `${r.source} -> ${r.destination}`)).toEqual([]);
  });

  it("no source is listed twice — redirects match in order, so a duplicate is dead code", () => {
    // A duplicate is worse than dead: the /browse pair existed twice with
    // DIFFERENT destinations, and the broken one won by being first.
    const seen = new Map<string, number>();
    for (const { source } of all) seen.set(source, (seen.get(source) ?? 0) + 1);
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([source]) => source);
    expect(dupes).toEqual([]);
  });
});
