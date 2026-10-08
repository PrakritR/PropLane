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
    expect(portalSource("portal-inbox-ui.tsx")).toContain('title = "Schedule message"');
    expect(source).toContain("InboxScheduledCard");
    expect(source).toContain('aria-haspopup="dialog"');
    expect(source).not.toContain("PORTAL_TABLE_DETAIL_ROW");
    expect(source).not.toContain("PortalTableExpandChevron");
    expect(threadList).toContain("InboxScheduledThreadList");
    expect(threadList).toContain('title="Scheduled messages"');
  });

  it("renders scheduled message detail with the shared compose field layout", () => {
    const inboxUi = portalSource("portal-inbox-ui.tsx");
    const composeFields = portalSource("portal-message-compose-fields.tsx");
    expect(inboxUi).toContain("PortalMessageRecipientReadonly");
    expect(composeFields).toContain("PortalMessageScheduleFields");
    expect(inboxUi).toContain("inbox-scheduled-schedule-at");
    expect(inboxUi).toContain("PORTAL_MESSAGE_COMPOSE_MODAL_PANEL_CLASS");
    expect(inboxUi).toContain('dataAttr="inbox-scheduled-detail-modal"');
  });

  it("keeps schedule-for-later in admin's New message and draws admin's scheduled sends inline in the thread", () => {
    // The separate admin Schedule panel is gone: a scheduled send is a card in its conversation
    // (the shared `InboxScheduledCard` pop-up edits and cancels it), and the compose still schedules.
    const compose = portalSource("admin-compose-modal.tsx");
    const thread = portalSource("admin-thread-pane.tsx");

    expect(compose).toContain('title={initialSchedule ? "Schedule message" : "New message"}');
    expect(compose).toContain("Schedule for later");
    expect(thread).toContain("useThreadScheduledCards");
    expect(thread).toContain("underHeader={scheduledCards}");
    expect(thread).toContain("InboxComposerScheduleMenu");
  });

  it("hides resident compose scheduling in the shared composer", () => {
    const composer = portalSource("pro-communication-compose-modal.tsx");
    const residentInbox = portalSource("resident-inbox-panel.tsx");

    // The control is dropped (not disabled) for a role whose capabilities do not
    // include scheduling; residents schedule from the thread composer only.
    expect(composer).toContain("{caps.schedule ? <InboxComposerScheduleMenu");
    expect(
      readFileSync(join(process.cwd(), "src/lib/role-compose.ts"), "utf8"),
    ).toMatch(/portal === "resident"\) \{[\s\S]*?schedule: false/);
    expect(residentInbox).not.toContain("resident-inbox-schedule-another");
  });
});
