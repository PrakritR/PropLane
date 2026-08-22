// Every `/api/...` path the client fetches must resolve to a real route handler.
//
// `pro-account-links-panel.tsx` called `/api/portal/purge-orphaned-co-manager-links` while the
// route lives at `/api/pro/...`. Nothing surfaced it: a 404 does NOT reject a fetch, so the
// `.then` chain carried on, the Team tab rendered normally, and orphaned co-manager links were
// simply never purged. The only trace was a 404 in the console.
//
// This is the same failure shape `AGENTS.md` records for `claw-resident-links.ts` — a link
// builder naming a path with no route, invisible to the build and to unit tests that assert the
// broken literal. So assert the path RESOLVES, never that it equals a string we also wrote.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");
const APP = join(SRC, "app");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * A route exists when the directory holds a route handler, allowing for dynamic segments.
 *
 * A trailing slash means the literal was a template prefix — `` `/api/reports/${id}` `` — so the
 * leaf is supplied at runtime. Those resolve when the prefix directory exists AND offers a
 * dynamic child to land in; requiring a `route.ts` directly under the prefix would fail every
 * legitimate by-id endpoint.
 */
function routeExists(apiPath: string): boolean {
  const isPrefix = apiPath.endsWith("/");
  const segments = apiPath.replace(/^\//, "").split("/").filter(Boolean);
  if (isPrefix) {
    const dir = join(APP, ...segments);
    try {
      return readdirSync(dir).some((entry) => /^\[.+\]$/.test(entry));
    } catch {
      return false;
    }
  }

  const descend = (dir: string, rest: string[]): boolean => {
    if (rest.length === 0) {
      return ["route.ts", "route.tsx", "route.js"].some((f) => {
        try {
          return statSync(join(dir, f)).isFile();
        } catch {
          return false;
        }
      });
    }
    const [head, ...tail] = rest;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return false;
    }
    // Exact segment, then a route group `(x)`, then a dynamic `[x]` / catch-all.
    if (entries.includes(head!) && descend(join(dir, head!), tail)) return true;
    for (const entry of entries) {
      if (/^\(.+\)$/.test(entry) && descend(join(dir, entry), rest)) return true;
      if (/^\[.+\]$/.test(entry) && descend(join(dir, entry), tail)) return true;
    }
    return false;
  };

  return descend(APP, segments);
}

describe("client API paths resolve to real routes", () => {
  it("every fetched /api path has a route handler", () => {
    const called = new Set<string>();
    for (const file of walk(SRC)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/fetch\(\s*["'`](\/api\/[a-zA-Z0-9/_-]+)/g)) {
        called.add(m[1]!);
      }
    }
    // Sanity: the sweep must actually find call sites, or it passes by finding nothing.
    expect(called.size).toBeGreaterThan(50);

    const missing = [...called].filter((p) => !routeExists(p)).sort();
    expect(missing).toEqual([]);
  });

  it("recognizes a path that does not exist (negative control)", () => {
    expect(routeExists("/api/portal/purge-orphaned-co-manager-links")).toBe(false);
    expect(routeExists("/api/pro/purge-orphaned-co-manager-links")).toBe(true);
  });
});
