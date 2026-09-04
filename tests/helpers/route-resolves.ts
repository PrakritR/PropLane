import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Does the Next app router resolve this pathname to a page or route handler?
 *
 * Extracted so the two places that need it — the link-builder test and the
 * redirect-destination test — share ONE implementation. Both exist because a
 * path that names no route fails silently: no build error, and an assertion on
 * the literal string passes while the URL 404s.
 */
const APP_DIR = resolve(__dirname, "../../src/app");

const OPTIONAL_CATCH_ALL = /^\[\[\.{3}.+\]\]$/;
const CATCH_ALL = /^\[\.{3}.+\]$/;
const DYNAMIC = /^\[(?!\[|\.{3}).+\]$/;
const ROUTE_GROUP = /^\(.+\)$/;

function childDirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((e) => statSync(join(dir, e)).isDirectory());
  } catch {
    return [];
  }
}

function hasPage(dir: string): boolean {
  try {
    return readdirSync(dir).some((f) => /^(page|route)\.(t|j)sx?$/.test(f));
  } catch {
    return false;
  }
}

/**
 * True when the app router can resolve `pathname` to a page or route handler.
 *
 * Models the four things that decide it: literal segments, `[dynamic]` ones,
 * `[...catchAll]` / `[[...optional]]` (the optional form matches ZERO segments,
 * which is how `/portal/properties` resolves through
 * `portal/[section]/[[...tab]]/page.tsx` even though `portal/properties/` holds
 * only `[stage]/`), and `(group)` directories, which are invisible in the URL.
 */
export function routeResolves(pathname: string, dir = APP_DIR): boolean {
  const path = pathname.split("?")[0] ?? "/";
  const segments = path.split("/").filter(Boolean);
  const children = childDirs(dir);

  if (segments.length === 0) {
    if (hasPage(dir)) return true;
    // An optional catch-all also matches no segments at all.
    if (children.some((c) => OPTIONAL_CATCH_ALL.test(c) && hasPage(join(dir, c)))) return true;
    return children.some((c) => ROUTE_GROUP.test(c) && routeResolves("/", join(dir, c)));
  }

  const [head, ...rest] = segments;
  const restPath = `/${rest.join("/")}`;
  const ordered = [
    ...children.filter((c) => c === head),
    ...children.filter((c) => DYNAMIC.test(c)),
    ...children.filter((c) => CATCH_ALL.test(c) || OPTIONAL_CATCH_ALL.test(c)),
  ];
  for (const candidate of ordered) {
    const next = join(dir, candidate);
    // Either catch-all form swallows every remaining segment.
    if ((CATCH_ALL.test(candidate) || OPTIONAL_CATCH_ALL.test(candidate)) && hasPage(next)) return true;
    if (routeResolves(restPath, next)) return true;
  }
  // Route groups do not consume a segment.
  return children.some((c) => ROUTE_GROUP.test(c) && routeResolves(path, join(dir, c)));
}

