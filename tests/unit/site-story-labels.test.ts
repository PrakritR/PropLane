import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STORY_PORTAL_LABELS } from "@/components/marketing/site/story";

/**
 * The home page's scroll story draws the portal's Communication inbox and the
 * dashboard queue. Its control labels must be the portal's own, so the screen a
 * visitor plays with on the site is the screen they meet after signing up. If a
 * portal label changes, change the story with it — never let the marketing copy
 * drift.
 */
describe("site story mirrors the portal's labels", () => {
  const inbox = readFileSync("src/components/portal/portal-inbox-ui.tsx", "utf8");
  const dashboard = readFileSync("src/components/portal/pro-dashboard.tsx", "utf8");

  it("uses the inbox's AI and channel labels", () => {
    expect(inbox).toContain(`"${STORY_PORTAL_LABELS.generate}"`);
    expect(inbox).toContain(STORY_PORTAL_LABELS.ask);
    for (const c of STORY_PORTAL_LABELS.channels) expect(inbox).toContain(`"${c}"`);
  });

  it("uses the dashboard's queue labels", () => {
    expect(dashboard).toContain(STORY_PORTAL_LABELS.queue);
    expect(dashboard).toContain(`"${STORY_PORTAL_LABELS.approve}"`);
    expect(dashboard).toContain(STORY_PORTAL_LABELS.discard);
  });
});
