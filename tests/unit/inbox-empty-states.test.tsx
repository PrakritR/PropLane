// @vitest-environment jsdom
//
// Communication UX quality pass: every inbox tab (Unopened, Opened, Schedule,
// Sent, Trash) must render the SAME polished empty treatment as the Schedule
// tab — the shared empty state (PortalEmptyState) with tab-specific copy —
// across all four portals. The list panes derive their copy from the shared
// `inboxTabEmptyCopy` helper; the thread pane (`InboxThreadView`) renders the
// same PortalInboxEmptyState card instead of the old bare "<p>No messages yet".
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  InboxThreadView,
  inboxTabEmptyCopy,
} from "@/components/portal/portal-inbox-ui";

afterEach(() => cleanup());

describe("inboxTabEmptyCopy", () => {
  it("gives tab-specific copy for every Communication tab", () => {
    expect(inboxTabEmptyCopy("unopened")).toBe("No unopened messages yet.");
    expect(inboxTabEmptyCopy("opened")).toBe("No opened messages yet.");
    expect(inboxTabEmptyCopy("sent")).toBe("No sent messages yet.");
    expect(inboxTabEmptyCopy("trash")).toBe("No trash messages yet.");
    // Matches the Schedule reference wording the other tabs are aligned to.
    expect(inboxTabEmptyCopy("schedule")).toBe("No scheduled messages in this window.");
  });

  it("falls back to a neutral label for an unknown tab", () => {
    expect(inboxTabEmptyCopy("unknown")).toBe("No messages yet.");
    expect(inboxTabEmptyCopy("")).toBe("No messages yet.");
  });
});

describe("InboxThreadView empty state", () => {
  it("renders the shared empty state (not a bare paragraph) when a thread has no messages", () => {
    const { container } = render(
      <InboxThreadView title="Jane Resident" messages={[]} emptyLabel="No messages in this conversation." />,
    );
    // The tab-specific copy is shown…
    expect(screen.getByText("No messages in this conversation.")).toBeTruthy();
    // …inside the shared polished empty-state card, same chrome as Schedule.
    // Portal redesign: the shared empty state is a flat centred block (outlined
    // glyph tile + one bold title, no card chrome), not a bare paragraph.
    const tile = container.querySelector('[data-slot="portal-list-empty-tile"]');
    expect(tile).not.toBeNull();
    expect(container.querySelector("h3")?.textContent).toBe("No messages in this conversation.");
  });

  it("renders message bubbles (no empty card) when the thread has messages", () => {
    render(
      <InboxThreadView
        title="Jane Resident"
        threadKey="thread-1"
        messages={[
          { id: "m1", author: "Jane", body: "Hello there", at: "9:00 AM", direction: "inbound" },
        ]}
        emptyLabel="No messages in this conversation."
      />,
    );
    expect(screen.getByText("Hello there")).toBeTruthy();
    expect(screen.queryByText("No messages in this conversation.")).toBeNull();
  });
});
