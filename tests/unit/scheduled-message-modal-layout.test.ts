import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const portalSource = (filename: string) =>
  readFileSync(join(process.cwd(), "src/components/portal", filename), "utf8");

describe("scheduled message modal layout", () => {
  it("opens manager scheduled-message detail in a dialog with the inline scheduled card", () => {
    const source = portalSource("pro-inbox-schedule-panel.tsx");
    const threadList = portalSource("portal-inbox-ui.tsx");

    // The panel opens the SHARED detail modal, which owns the title as a default
    // prop (`portal-inbox-ui.tsx`) instead of each caller repeating the literal.
    expect(source).toContain("<ScheduledMessageDetailModal");
    expect(portalSource("portal-inbox-ui.tsx")).toContain('title = "Scheduled message"');
    expect(source).toContain("InboxScheduledCard");
    expect(source).toContain('aria-haspopup="dialog"');
    expect(source).not.toContain("PORTAL_TABLE_DETAIL_ROW");
    expect(source).not.toContain("PortalTableExpandChevron");
    expect(threadList).toContain("InboxScheduledThreadList");
    expect(threadList).toContain('title="Scheduled messages"');
  });

  it("renders scheduled message detail with the shared compose field layout", () => {
    const inboxUi = portalSource("portal-inbox-ui.tsx");
    expect(inboxUi).toContain("PortalMessageComposeModalBody");
    expect(inboxUi).toContain("PortalMessageRecipientReadonly");
    expect(inboxUi).toContain("PortalMessageScheduleFields");
    expect(inboxUi).toContain("inbox-scheduled-schedule-later");
    expect(inboxUi).toContain("PORTAL_MESSAGE_COMPOSE_MODAL_PANEL_CLASS");
  });

  it("uses the responsive modal for admin schedule creation and editing", () => {
    const panel = portalSource("admin-inbox-schedule-panel.tsx");
    const client = portalSource("admin-inbox-client.tsx");

    expect(panel).toContain('data-attr="admin-schedule-message"');
    expect(panel).toContain('title="Edit scheduled message"');
    expect(client).toContain('title={initialSchedule ? "Schedule message" : "New message"}');
  });
});
