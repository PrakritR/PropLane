import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STORY_PORTAL_LABELS } from "@/components/marketing/site/story";

/**
 * The home page's scroll story draws the portal inbox and dashboard. Its control
 * labels must be the portal's own, so the screen a visitor sees on the site is
 * the screen they meet after signing up. If a portal label changes, change the
 * story with it — never let the marketing copy drift.
 */
describe("site story mirrors the portal's labels", () => {
  const inbox = readFileSync("src/components/portal/portal-inbox-ui.tsx", "utf8");
  const dashboard = readFileSync("src/components/portal/pro-dashboard.tsx", "utf8");

  it("uses the inbox's assist and channel labels", () => {
    expect(inbox).toContain(`"${STORY_PORTAL_LABELS.generate}"`);
    expect(inbox).toContain(STORY_PORTAL_LABELS.ask);
    expect(inbox).toContain(`"${STORY_PORTAL_LABELS.schedule}"`);
    for (const c of STORY_PORTAL_LABELS.channels) expect(inbox).toContain(`"${c}"`);
    expect(inbox).toContain(STORY_PORTAL_LABELS.sendingAs);
  });

  it("uses the dashboard's AI-drafts labels", () => {
    expect(dashboard).toContain(STORY_PORTAL_LABELS.aiDrafts);
    expect(dashboard).toContain(STORY_PORTAL_LABELS.pending);
    expect(dashboard).toContain(`"${STORY_PORTAL_LABELS.approve}"`);
    expect(dashboard).toContain(STORY_PORTAL_LABELS.discard);
  });
});
