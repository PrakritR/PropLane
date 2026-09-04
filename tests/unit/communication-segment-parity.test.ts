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
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PANELS = {
  manager: "src/components/portal/pro-communication.tsx",
  resident: "src/components/portal/resident-communication.tsx",
  vendor: "src/components/portal/vendor-communication.tsx",
} as const;

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe.each(Object.entries(PANELS))("%s Communication segments", (_portal, path) => {
  const src = read(path);

  it("offers Active and Archived, and nothing else", () => {
    expect(src).toContain('dataAttr: "communication-segment-active"');
    expect(src).toContain('dataAttr: "communication-segment-archived"');
    expect(src).not.toContain('dataAttr: "communication-segment-unread"');
  });

  it("still resolves a bookmarked /unread onto Active", () => {
    expect(src).toContain('activeDestinationId={listSegment === "unread" ? "active" : listSegment}');
  });
});
