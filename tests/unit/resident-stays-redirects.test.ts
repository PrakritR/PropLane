import { readFileSync } from "node:fs";
import { join } from "node:path";
import { match } from "next/dist/compiled/path-to-regexp";
import { describe, expect, it } from "vitest";

import { routeResolves } from "../helpers/route-resolves";
import { residentPortalPath } from "@/lib/claw-resident-links";
import { stayRequestHref, STAY_REQUEST_PATH } from "@/lib/short-stay/stay-request-link";
import { residentStayRequestPath, buildProspectStayRequestHref } from "@/lib/prospect-public-nav";
import { stayAddOnPayPath, STAY_ADD_ON_LINK_PATH } from "@/lib/short-stay/stay-add-ons";

/**
 * Short stays are rows on the Application page (captain, Oct 27): there is no Stays tab. Every address that was ever
 * texted or emailed (`/resident/stays`, `/resident/stays/upcoming`, `/resident/stays/request?...`) must still land, and
 * every address the code mints today must resolve against the real app tree. `next.config.ts` redirects outrank the app
 * router (AGENTS.md > Portal routing precedence), so the map is read from the config and matched in order, the way
 * Next does.
 */

type Redirect = { source: string; destination: string };

function redirects(): Redirect[] {
  const config = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
  return [...config.matchAll(/\{\s*source:\s*"([^"]+)",\s*destination:\s*"([^"]+)"/g)].map((m) => ({ source: m[1]!, destination: m[2]! }));
}

/** The first redirect whose source matches `pathname` (Next applies them in order). */
function firstRedirect(pathname: string): Redirect | null {
  for (const redirect of redirects()) {
    if (match(redirect.source)(pathname)) return redirect;
  }
  return null;
}

describe("the retired /resident/stays addresses", () => {
  it.each([
    ["/resident/stays", "/resident/applications/approved"],
    ["/resident/stays/upcoming", "/resident/applications/approved"],
    ["/resident/stays/past", "/resident/applications/approved"],
    ["/resident/stays/request", "/resident/applications/stay"],
  ])("%s redirects to %s", (from, to) => {
    expect(firstRedirect(from)?.destination).toBe(to);
  });

  it("every destination resolves to a real route", () => {
    for (const from of ["/resident/stays", "/resident/stays/upcoming", "/resident/stays/request"]) {
      const destination = firstRedirect(from)!.destination;
      expect({ from, destination, resolves: routeResolves(destination) }).toEqual({ from, destination, resolves: true });
    }
  });

  it("the request redirect is listed before the catch-all, so it keeps the form", () => {
    const sources = redirects().map((r) => r.source);
    expect(sources.indexOf("/resident/stays/request")).toBeGreaterThanOrEqual(0);
    expect(sources.indexOf("/resident/stays/request")).toBeLessThan(sources.indexOf("/resident/stays/:path*"));
  });
});

describe("every link builder hands out a path that resolves (never the retired one)", () => {
  const minted = [
    ["residentPortalPath('stays')", residentPortalPath("stays")],
    ["stayRequestHref", stayRequestHref({ listing: "p1", room: "r1", checkIn: "2026-11-02", checkOut: "2026-11-04", guests: 2 })],
    ["STAY_REQUEST_PATH", STAY_REQUEST_PATH],
    ["residentStayRequestPath", residentStayRequestPath("p1", { roomId: "r1", checkIn: "2026-11-02", checkOut: "2026-11-04", guests: 2 })],
    ["buildProspectStayRequestHref (signed in)", buildProspectStayRequestHref("p1", { roomId: "r1" }, { ready: true, userId: "u1", hasResidentRole: true })],
    ["STAY_ADD_ON_LINK_PATH", STAY_ADD_ON_LINK_PATH],
    ["stayAddOnPayPath", stayAddOnPayPath({ blockId: "b1", kind: "early_check_in", time: "12:00" })],
  ] as const;

  it.each(minted)("%s", (_name, path) => {
    expect(path).not.toMatch(/\/resident\/stays/);
    expect(path.split("?")[0]).toMatch(/^\/resident\/applications\//);
    // Nothing redirects it away, and the app tree has a page for it.
    expect(firstRedirect(path.split("?")[0]!)).toBeNull();
    expect(routeResolves(path)).toBe(true);
  });

  it("the stay request keeps its picks as the query", () => {
    const href = stayRequestHref({ listing: "p1", room: "r1", checkIn: "2026-11-02", checkOut: "2026-11-04", guests: 2 });
    expect(href).toBe("/resident/applications/stay?listing=p1&room=r1&checkIn=2026-11-02&checkOut=2026-11-04&guests=2");
  });
});
