// @vitest-environment jsdom
/**
 * Opening New message from a resident's house starter row: the house's manager is preselected (the starter names
 * their WORK email, the picker lists their account email), and opening settles in a bounded number of renders.
 */
import { Profiler, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => vi.fn(),
  useAppUi: () => ({ showToast: vi.fn() }),
}));
const channelsFor = () => ({ viaEmail: true, viaSms: false });
vi.mock("@/hooks/use-manager-communication-deliver-via", () => ({
  useManagerCommunicationDeliverVia: () => ({ channelsFor }),
}));
vi.mock("@/components/portal/popup-live-preview", () => ({
  PopupMessagePreview: () => null,
  PopupRecordPreview: () => null,
}));
vi.mock("@/components/portal/portal-dialog", () => ({
  PortalDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
}));

import { ManagerCommunicationComposeModal } from "@/components/portal/pro-communication-compose-modal";
import type { InboxScopedContact } from "@/data/inbox-scoped-directory";

const manager: InboxScopedContact = {
  id: "mgr-9684",
  name: "Test Manager 2",
  email: "manager2@test.proplane.local",
  role: "manager",
};
const contacts = [manager];
const noop = () => {};

function mount(draft: { subject: string; body: string; recipientEmail?: string; recipientName?: string }) {
  const commits = vi.fn();
  render(
    <Profiler id="compose" onRender={commits}>
      <ManagerCommunicationComposeModal
        open
        onClose={noop}
        onSend={async () => true}
        portal="resident"
        liveContacts={contacts}
        residentDraft={draft}
      />
    </Profiler>,
  );
  return commits;
}

afterEach(cleanup);

describe("resident house starter compose", () => {
  it("preselects the manager when the starter carries their work email and name", async () => {
    const commits = mount({
      subject: "Question about Cedar Flat 2B",
      body: "",
      recipientEmail: "assist-test-manager-2@proplane.ai",
      recipientName: "Test Manager 2",
    });
    await waitFor(() => expect(screen.getAllByText(/Test Manager 2/).length).toBeGreaterThan(0));
    // Let any effect chain run to completion, then prove it stopped.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const settled = commits.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(commits.mock.calls.length).toBe(settled);
    expect(settled).toBeLessThan(25);
  });

  it("falls back to the only manager when the work email matches nothing and no name is given", async () => {
    mount({ subject: "Hi", body: "", recipientEmail: "work-line@proplane.ai" });
    await waitFor(() => expect(screen.getAllByText(/Test Manager 2/).length).toBeGreaterThan(0));
  });

  it("still matches by the account email", async () => {
    mount({ subject: "Hi", body: "", recipientEmail: "MANAGER2@test.proplane.local" });
    await waitFor(() => expect(screen.getAllByText(/Test Manager 2/).length).toBeGreaterThan(0));
  });
});
