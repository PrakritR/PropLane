// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: vi.fn() }),
}));
vi.mock("@/components/portal/payment-schedule-ui", () => ({
  useScheduledPaymentMessages: () => ({ messages: [], reload: vi.fn() }),
  patchScheduledMessage: vi.fn(),
}));
vi.mock("@/components/portal/portal-message-compose-fields", () => ({
  defaultScheduleSendAtLocal: () => "2026-09-13T12:00",
}));
vi.mock("@/components/portal/portal-inbox-selection", () => ({
  sendAutomationScheduledMessageNow: vi.fn(),
  sendManualScheduledMessageNow: vi.fn(),
}));
vi.mock("@/components/portal/inbox-thread-assistant-strip", () => ({
  InboxThreadAssistantStrip: () => null,
  buildInboxThreadAssistantContext: () => "",
}));
vi.mock("@/components/portal/portal-contact-details-modal", () => ({
  PortalContactDetailsModal: () => null,
}));
vi.mock("@/components/portal/pro-inbox", () => ({ ManagerInbox: () => null }));
vi.mock("@/lib/portal-api-error", () => ({ readPortalApiError: async () => "error" }));
vi.mock("@/lib/inbox-scheduled-thread", () => ({ scheduledItemsForRecipient: () => [] }));
vi.mock("@/lib/assistant-inbox-reply", () => ({ sendPropLaneAssistantInboxMessage: vi.fn() }));
vi.mock("@/lib/inbox-attachments", () => ({
  INBOX_MAX_ATTACHMENTS: 5,
  createPendingInboxAttachment: vi.fn(),
  revokeInboxAttachmentPreview: vi.fn(),
  uploadInboxAttachment: vi.fn(),
}));
vi.mock("@/lib/manager-inbox-reply-channels", () => ({
  hasInboxReplyChannelSelected: () => true,
  resolveCommunicationPersonThreadReplyChannels: () => ({ viaProplane: true, viaEmail: false, viaSms: false }),
}));
vi.mock("@/lib/manager-sms-messages", () => ({
  normalizeManagerSmsConversationsPayload: (value: unknown) => value,
}));
vi.mock("@/lib/portal-inbox-storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadPersistedInbox: () => [],
  inboxThreadMessages: (thread: { id: string; from: string; body: string; time: string; rootAt?: string; attachments?: unknown[]; messages?: unknown[] }) => [
    { id: `${thread.id}-root`, from: thread.from, body: thread.body, at: thread.rootAt ?? thread.time, attachments: thread.attachments },
    ...(thread.messages ?? []),
  ],
}));
vi.mock("@/components/portal/portal-inbox-ui", () => ({
  INBOX_THREAD_ICON_BTN: "",
  INBOX_THREAD_ICON_BTN_DANGER: "",
  InboxComposer: () => null,
  AiDraftReplyCard: () => null,
  InboxReplyChannelPicker: () => null,
  InboxScheduledCard: () => null,
  InboxScheduledThreadList: () => null,
  InboxTwoPane: ({ thread }: { thread: React.ReactNode }) => <div>{thread}</div>,
  InboxThreadView: ({ messages }: { messages: Array<{ body: string; attachments?: Array<{ name?: string }> }> }) => (
    <div data-testid="rendered-thread">
      {messages.map((message, index) => (
        <div key={`${message.body}-${index}`}>
          <span>{message.body}</span>
          {message.attachments?.map((attachment) => <span key={attachment.name}>{attachment.name}</span>)}
        </div>
      ))}
    </div>
  ),
}));

import { ResidentDirectChatPane } from "@/components/portal/pro-resident-detail-inbox";

const emailThread = (id: string, email: string, body: string, attachment: string) => ({
  id,
  folder: "inbox" as const,
  from: "Resident",
  email,
  subject: body,
  preview: body,
  body,
  time: "Sep 13, 2026",
  unread: true,
  attachments: [{ url: `/files/${attachment}`, name: attachment }],
  messages: [{ id: `${id}-append`, from: "Resident", body: `${body} appended`, at: "Sep 13, 2026", attachments: [{ url: "/files/append.pdf", name: "append.pdf" }] }],
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ResidentDirectChatPane observed-read behavior", () => {
  it("renders every selected email alias from the authorized snapshot with attachments and SMS", async () => {
    const onViewed = vi.fn(() => true);
    render(
      <ResidentDirectChatPane
        residentEmail="new@example.com"
        residentName="Resident"
        smsUiEnabled
        smsResidents={[{
          residentEmail: "new@example.com",
          name: "Resident",
          phone: "+12065550142",
          conversationKey: "binding-1",
          messages: [{ id: "sms-1", direction: "inbound", body: "SMS body", createdAt: "2026-09-13T18:00:00.000Z" }],
        } as never]}
        readSources={[
          { id: "email-a", observation: "obs-a" },
          { id: "email-b", observation: "obs-b" },
        ]}
        emailThreadSnapshot={[
          emailThread("email-a", "old@example.com", "Old alias body", "old.pdf"),
          emailThread("email-b", "new@example.com", "New alias body", "new.pdf"),
        ]}
        onViewed={onViewed}
        onSent={vi.fn()}
        smsResident={null}
      />,
    );

    expect(await screen.findByText("Old alias body")).toBeTruthy();
    expect(screen.getByText("New alias body")).toBeTruthy();
    expect(screen.getByText("Old alias body appended")).toBeTruthy();
    expect(screen.getByText("New alias body appended")).toBeTruthy();
    expect(screen.getByText("old.pdf")).toBeTruthy();
    expect(screen.getAllByText("append.pdf")).toHaveLength(2);
    expect(screen.getByText("SMS body")).toBeTruthy();
    await waitFor(() => expect(onViewed).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ id: "email-a" }),
      expect.objectContaining({ id: "email-b" }),
    ])));
  });

  it("does not acknowledge while hidden, then performs one bounded acknowledgement when visible", async () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const onViewed = vi.fn(() => true);
    const props = {
      residentEmail: "resident@example.com",
      smsUiEnabled: false,
      readSources: [{ id: "email-a", observation: "obs-a" }],
      emailThreadSnapshot: [emailThread("email-a", "resident@example.com", "Body", "body.pdf")],
      onViewed,
      onSent: vi.fn(),
      smsResident: null,
    } as const;
    const { rerender } = render(<ResidentDirectChatPane {...props} />);
    await Promise.resolve();
    expect(onViewed).not.toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    rerender(<ResidentDirectChatPane {...props} />);
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(onViewed).toHaveBeenCalledTimes(1));
    rerender(<ResidentDirectChatPane {...props} />);
    await Promise.resolve();
    expect(onViewed).toHaveBeenCalledTimes(1);
  });

  it("retries the represented sources when a new inbound SMS changes the visible signature", async () => {
    const onViewed = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const sms = (id: string) => ({
      residentEmail: "resident@example.com",
      name: "Resident",
      phone: "+12065550142",
      conversationKey: "binding-1",
      messages: [{ id, direction: "inbound", body: id, createdAt: "2026-09-13T18:00:00.000Z" }],
    });
    const props = {
      residentEmail: "resident@example.com",
      smsUiEnabled: true,
      smsResidents: [sms("sms-1")],
      readSources: [{ id: "email-a", observation: "obs-a" }],
      emailThreadSnapshot: [emailThread("email-a", "resident@example.com", "Body", "body.pdf")],
      onViewed,
      onSent: vi.fn(),
      smsResident: null,
    } as const;
    const { rerender } = render(<ResidentDirectChatPane {...props} />);
    await waitFor(() => expect(onViewed).toHaveBeenCalledTimes(1));
    rerender(<ResidentDirectChatPane {...props} smsResidents={[sms("sms-1"), sms("sms-2")]} />);
    await waitFor(() => expect(onViewed).toHaveBeenCalledTimes(2));
    expect(onViewed).toHaveBeenLastCalledWith([{ id: "email-a", observation: "obs-a" }]);
  });
});
