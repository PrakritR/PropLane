/**
 * One inbox, three segments, in every portal.
 *
 * AGENTS.md: "Communication is ONE conversation-based inbox with NO folder
 * tabs." The segments are VIEWS of that one list — All, Unread (is this thread
 * unread), Archived — never folders, and every portal shows the same three
 * (Property Studio round 2, §13). They are owned once, in the shared rail, so
 * the portals cannot drift apart again.
 *
 * The segment rail MOVED. It used to be typed out per portal in a
 * `PortalListControlStack` above the panel; it now lives once in
 * `InboxListSegmentRail` and renders inside each portal's conversation-list
 * card. So the destination literals are asserted on the shared owner, and each
 * portal is checked for the thing that actually matters to it — that it mounts
 * that rail and hands it the segment straight from the route.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** The one component that owns the two destinations for every portal. */
const RAIL = "src/components/portal/portal-inbox-ui.tsx";

const PANELS = {
  resident: "src/components/portal/resident-communication.tsx",
  vendor: "src/components/portal/vendor-communication.tsx",
  // The manager's list pane, where its rail is mounted. `pro-communication.tsx`
  // is the page shell above it and owns no segments of its own.
  manager: "src/components/portal/pro-unified-inbox.tsx",
} as const;

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("the shared segment rail", () => {
  const src = read(RAIL);

  it("offers All, Unread and Archived, and nothing else", () => {
    expect(src).toContain('dataAttr: "communication-segment-active"');
    expect(src).toContain('dataAttr: "communication-segment-unread"');
    expect(src).toContain('dataAttr: "communication-segment-archived"');
    expect((src.match(/dataAttr: "communication-segment-/g) ?? []).length).toBe(3);
  });

  it("highlights the segment from the route, /unread included", () => {
    expect(src).toMatch(/activeId=\{listSegment\}/);
  });

  it("routes both segments as links rather than re-adding folder tabs", () => {
    expect(src).toContain("`${commBase}/active`");
    expect(src).toContain("`${commBase}/unread`");
    expect(src).toContain("`${commBase}/archived`");
    // DestinationNav renders next/link items; a button-based tab strip here
    // would break deep-linking and reintroduce folders.
    expect(src).toContain("<DestinationNav");
  });
});

describe.each(Object.entries(PANELS))("%s Communication segments", (_portal, path) => {
  const src = read(path);

  it("mounts the shared rail with the segment from the route", () => {
    expect(src).toMatch(/<InboxListSegmentRail\s+commBase=\{commBase\}\s+listSegment=\{listSegment\}/);
  });

  it("does not re-declare its own destinations", () => {
    expect(src).not.toContain('dataAttr: "communication-segment-active"');
    expect(src).not.toContain('dataAttr: "communication-segment-unread"');
  });
});
