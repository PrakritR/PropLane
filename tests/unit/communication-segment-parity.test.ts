/**
 * One inbox, two segments, in every portal.
 *
 * AGENTS.md: "Communication is ONE conversation-based inbox with NO folder
 * tabs." The manager panel is the reference and carries exactly Active and
 * Archived. The resident and vendor panels each grew a third "Unread"
 * destination — which is a FILTER (is this thread unread), not a folder, and it
 * put the two portals out of step with the surface they are meant to copy.
 *
 * The `/unread` URL still resolves in all three: a segment that stops being a
 * tab should not become a 404 for anyone who bookmarked it. It just highlights
 * Active, which is where those conversations live.
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

  it("offers Active and Archived, and nothing else", () => {
    expect(src).toContain('dataAttr: "communication-segment-active"');
    expect(src).toContain('dataAttr: "communication-segment-archived"');
    expect(src).not.toContain('dataAttr: "communication-segment-unread"');
  });

  it("still resolves a bookmarked /unread onto Active", () => {
    expect(src).toMatch(/activeId=\{listSegment === "unread" \? "active" : listSegment\}/);
  });

  it("routes both segments as links rather than re-adding folder tabs", () => {
    expect(src).toContain("`${commBase}/active`");
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
