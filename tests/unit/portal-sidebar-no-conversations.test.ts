import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { demoSidebar } from "@/components/marketing/site/product-mock/sidebar-data";
import { worldFor } from "@/components/marketing/site/product-mock/world";

// Captain: "remove Conversations section from sidebar". Communication is the
// single entry to messages in every portal; the sidebar carries no recent-thread
// list of its own, and the home demo (which derives its sidebar from the same
// nav) does not draw one either.
describe("the sidebar has no Conversations group", () => {
  it("the real sidebar renders no conversations group or thread links", () => {
    const src = readFileSync("src/components/portal/portal-sidebar.tsx", "utf8");
    expect(src).not.toContain('data-nav-group="conversations"');
    expect(src).not.toContain("portal-sidebar-conversation");
    expect(src).not.toContain("useSidebarConversations");
  });

  it("the home demo's sidebar data is badges only, for every portal", () => {
    const story = worldFor().story;
    for (const portal of ["manager", "resident", "vendor"] as const) {
      expect(Object.keys(demoSidebar(portal, story, "forms"))).toEqual(["badges"]);
    }
    const demo = readFileSync("src/components/marketing/resident-lifecycle-workspace.tsx", "utf8");
    expect(demo).not.toContain('data-nav-group="conversations"');
  });
});
