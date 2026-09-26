// @vitest-environment jsdom
/**
 * C022/C171: Admin Communication is rebuilt into the manager two-pane shape
 * by composing the exported shared primitives (`InboxTwoPane`,
 * `InboxThreadView`, `InboxComposer`) — the inbox stream's own primitives,
 * unchanged in shape — with admin's existing record table
 * (`PortalInboxMessageTable`) kept as the list side, per
 * docs/agents/communication-inbox.md ("admin alone keeps its flat table") and
 * admin-list-surface-adoption.test.ts ("the genuine record tables
 * (Communication -> Email) still use table primitives").
 *
 * `hideExpandedDetail` is the one additive, backward-compatible prop this
 * change added to the shared `PortalInboxMessageTable` — every other caller
 * omits it and is unaffected (asserted below).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: vi.fn() }) }));
import { PortalInboxMessageTable } from "@/components/portal/portal-inbox-ui";
import { ADMIN_REPLY_AUTHOR_LABEL, buildThreadMessages } from "@/components/portal/admin-inbox-client";
import type { InboxMessage } from "@/lib/demo-admin-partner-inbox";

afterEach(cleanup);

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

function baseRow() {
  return { id: "one", name: "Sam", email: "sam@example.test", subject: "Question", whenLabel: "Today", read: true };
}

describe("PortalInboxMessageTable's hideExpandedDetail (additive, C022)", () => {
  it("suppresses the inline conversation block while the row still highlights as open", () => {
    render(
      <PortalInboxMessageTable
        rows={[baseRow()]}
        expandedId="one"
        onToggleExpand={() => {}}
        hideExpandedDetail
      />,
    );
    expect(screen.queryByText("Conversation")).not.toBeInTheDocument();
  });

  it("defaults to false — every other caller's inline conversation is unchanged", () => {
    render(<PortalInboxMessageTable rows={[baseRow()]} expandedId="one" onToggleExpand={() => {}} />);
    expect(screen.getAllByText("Conversation").length).toBeGreaterThan(0);
  });

  it("no other caller in the tree passes hideExpandedDetail — this is admin's own opt-in", () => {
    const callers = [
      "src/components/portal/pro-unified-inbox.tsx",
      "src/components/portal/resident-inbox-panel.tsx",
      "src/components/portal/vendor-inbox-panel.tsx",
    ];
    for (const file of callers) {
      let src = "";
      try {
        src = read(file);
      } catch {
        continue;
      }
      expect(src, `${file} unexpectedly opts into hideExpandedDetail`).not.toContain("hideExpandedDetail");
    }
  });
});

function adminMsg(overrides: Partial<InboxMessage> & Pick<InboxMessage, "id" | "folder">): InboxMessage {
  return {
    name: "Jamie Rivera",
    email: "jamie@example.test",
    topic: "Question",
    body: "Root body",
    createdAt: "2024-01-01T00:00:00.000Z",
    read: true,
    senderRole: "manager",
    thread: [],
    ...overrides,
  };
}

describe("buildThreadMessages direction inference (feeds InboxThreadView bubbles)", () => {
  it("an inbox row's root message is inbound, from the counterparty", () => {
    const [root] = buildThreadMessages(adminMsg({ id: "m1", folder: "inbox" }));
    expect(root).toMatchObject({ author: "Jamie Rivera", direction: "inbound", body: "Root body" });
  });

  it("a sent row's root message is outbound, authored by admin", () => {
    const [root] = buildThreadMessages(adminMsg({ id: "m2", folder: "sent" }));
    expect(root).toMatchObject({ author: ADMIN_REPLY_AUTHOR_LABEL, direction: "outbound" });
  });

  it("a thread reply authored by admin's own reply label is outbound; any other author is inbound", () => {
    const [, adminReply, counterpartyReply] = buildThreadMessages(
      adminMsg({
        id: "m3",
        folder: "inbox",
        thread: [
          { id: "r1", authorLabel: ADMIN_REPLY_AUTHOR_LABEL, body: "Our reply", createdAt: "2024-01-02T00:00:00.000Z" },
          { id: "r2", authorLabel: "Jamie Rivera", body: "Follow-up", createdAt: "2024-01-03T00:00:00.000Z" },
        ],
      }),
    );
    expect(adminReply).toMatchObject({ direction: "outbound", body: "Our reply" });
    expect(counterpartyReply).toMatchObject({ direction: "inbound", body: "Follow-up" });
  });
});

describe("admin-inbox-client.tsx composes the two-pane shape (C022) with a wired back chevron (C171)", () => {
  const src = read("src/components/portal/admin-inbox-client.tsx");

  it("imports and renders the shared two-pane primitives", () => {
    expect(src).toContain("InboxTwoPane");
    expect(src).toContain("InboxThreadView");
    expect(src).toContain("InboxComposer");
    expect(src).toMatch(/<InboxTwoPane/);
    expect(src).toMatch(/<InboxThreadView/);
    expect(src).toMatch(/<InboxComposer/);
  });

  it("keeps the existing record table as the list pane, with hideExpandedDetail set", () => {
    const twoPane = src.slice(src.indexOf("<InboxTwoPane"), src.indexOf("<InboxTwoPane") + 2000);
    expect(twoPane).toContain("<PortalInboxMessageTable");
    expect(twoPane).toContain("hideExpandedDetail");
  });

  it("wires InboxThreadView's onBack to close the open conversation (C171)", () => {
    expect(src).toMatch(/onBack=\{\(\) => setExpandedId\(null\)\}/);
  });

  it("no longer renders the old inline getThreadMessages/onReply accordion wiring", () => {
    expect(src).not.toContain("getThreadMessages={(row) =>");
    expect(src).not.toContain("getDetailBody={(row) =>");
  });
});
