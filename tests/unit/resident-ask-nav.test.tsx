// @vitest-environment jsdom
// Resident Ask: a center tab on the phone bar (the assistant, not a section) and a desktop card on the dashboard.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RESIDENT_BOTTOM_NAV_PRIMARY, residentSectionLockedForStage, type ResidentPortalNavStage } from "@/lib/resident-portal-nav";
import { residentBarWithAsk, RESIDENT_ASK_BAR_SLOT } from "@/lib/native/portal-bottom-nav";
import { PortalNativeAskNavButton } from "@/components/portal/portal-native-ask-nav-button";
import { residentAssistantHasUnread } from "@/hooks/use-resident-assistant-unread";

const store = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("@/lib/portal-inbox-storage", async (original) => ({
  ...(await original<typeof import("@/lib/portal-inbox-storage")>()),
  loadPersistedInbox: () => store.rows,
}));

afterEach(() => {
  cleanup();
  store.rows = [];
});

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const STAGES = Object.keys(RESIDENT_BOTTOM_NAV_PRIMARY) as ResidentPortalNavStage[];

describe("the Ask tab takes the center slot without touching the stage tables", () => {
  it("shows the first three sections, Ask at index 2, and moves the fourth (Messages) into More", () => {
    for (const stage of STAGES) {
      const primary = [...RESIDENT_BOTTOM_NAV_PRIMARY[stage]];
      const { bar, displaced, askIndex } = residentBarWithAsk(primary);
      expect(askIndex).toBe(RESIDENT_ASK_BAR_SLOT);
      expect(bar).toEqual(primary.slice(0, 3));
      expect(displaced).toEqual(["communication"]);
      // Together with Ask and More the bar is five slots, never six.
      expect(bar.length + 1 + 1).toBeLessThanOrEqual(5);
    }
  });

  it("Ask is not a section: it is in no stage table, and every table tab is still unlocked at its stage", () => {
    for (const stage of STAGES) {
      expect(RESIDENT_BOTTOM_NAV_PRIMARY[stage]).not.toContain("ask");
      for (const section of RESIDENT_BOTTOM_NAV_PRIMARY[stage]) expect(residentSectionLockedForStage(section, stage)).toBe(false);
    }
    expect(read("src/lib/resident-portal-nav.ts")).not.toMatch(/"ask"/);
  });

  it("a short bar (a plan-locked tab) keeps Ask at the end rather than past it", () => {
    expect(residentBarWithAsk(["a", "b"]).askIndex).toBe(2);
    expect(residentBarWithAsk(["a"]).askIndex).toBe(1);
  });

  it("the sidebar draws it only for a resident with an assistant mounted, at every stage", () => {
    const src = read("src/components/portal/portal-sidebar.tsx");
    expect(src).toContain("useResidentAskTab(definition.kind)");
    expect(read("src/hooks/use-resident-ask-tab.ts")).toContain('kind === "resident" && hasAssistant');
    expect(src).toContain("residentBarWithAsk");
    expect(src).toContain("<PortalNativeAskNavButton");
  });
});

describe("the Ask button", () => {
  it("opens the assistant and shows an unread dot only when asked to", () => {
    const onClick = vi.fn();
    const { rerender } = render(<PortalNativeAskNavButton open={false} unread={false} onClick={onClick} />);
    expect(document.querySelector('[data-attr="bottom-nav-ask-unread"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ask PropLane" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<PortalNativeAskNavButton open={false} unread onClick={onClick} />);
    expect(document.querySelector('[data-attr="bottom-nav-ask-unread"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Ask PropLane, new reply" })).toBeTruthy();
  });

  it("the dot reads only the resident's own assistant thread, unread, in the inbox", () => {
    const thread = (over: Record<string, unknown>) => ({ id: "resident-agent-u1", folder: "inbox", unread: true, ...over });
    store.rows = [thread({})];
    expect(residentAssistantHasUnread()).toBe(true);
    store.rows = [thread({ unread: false })];
    expect(residentAssistantHasUnread()).toBe(false);
    store.rows = [{ id: "msg_inbox_x", folder: "inbox", unread: true }];
    expect(residentAssistantHasUnread()).toBe(false);
  });
});

describe("the desktop card", () => {
  it("is on the resident dashboard, large screens only, and draws nothing without an assistant", () => {
    expect(read("src/components/portal/resident-dashboard.tsx")).toContain("<ResidentAskCard />");
    const card = read("src/components/portal/resident-ask-card.tsx");
    expect(card).toContain("hidden");
    expect(card).toContain("lg:flex");
    expect(card).toContain("if (!hasAssistant) return null;");
  });
});
