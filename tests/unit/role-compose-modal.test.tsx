// @vitest-environment jsdom
/**
 * New message is ONE composer. A resident and a vendor get the manager's
 * composer with only what their role may send: residents cannot schedule here
 * (they schedule from the thread composer) and nobody but a manager can Text;
 * a refused send keeps the draft and never touches the thread.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const showToast = vi.fn();

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => vi.fn(),
  useAppUi: () => ({ showToast }),
}));
// Stable identity, like the real hook's useCallback: the composer resets its
// fields when this changes.
const channelsFor = () => ({ viaEmail: true, viaSms: false });
vi.mock("@/hooks/use-manager-communication-deliver-via", () => ({
  useManagerCommunicationDeliverVia: () => ({ channelsFor }),
}));
vi.mock("@/components/portal/popup-live-preview", () => ({
  PopupMessagePreview: () => null,
  PopupRecordPreview: () => null,
}));
vi.mock("@/components/portal/portal-dialog", () => ({
  PortalDialog: ({
    open,
    children,
    primaryAction,
  }: {
    open: boolean;
    children: ReactNode;
    primaryAction?: { label: string; onClick: () => unknown; dataAttr?: string };
  }) =>
    open ? (
      <div role="dialog" aria-label="New message">
        {children}
        {primaryAction ? (
          <button type="button" data-attr={primaryAction.dataAttr} onClick={() => void primaryAction.onClick()}>
            {primaryAction.label}
          </button>
        ) : null}
      </div>
    ) : null,
}));

import { ManagerCommunicationComposeModal } from "@/components/portal/pro-communication-compose-modal";
import type { InboxScopedContact } from "@/data/inbox-scoped-directory";

const manager: InboxScopedContact = {
  id: "mgr-1",
  userId: "user-mgr-1",
  name: "Mina Manager",
  email: "mina@example.com",
  role: "manager",
};

afterEach(() => {
  cleanup();
  showToast.mockClear();
});

const scheduleButton = () => screen.queryByRole("button", { name: /schedule/i, hidden: false });
const toolsFor = (name: RegExp | string) => screen.queryByRole("button", { name });

function pickManagerAndWrite() {
  const to = screen.getByRole("combobox");
  fireEvent.focus(to);
  fireEvent.click(screen.getByRole("option", { name: /Mina Manager/ }));
  fireEvent.change(screen.getByPlaceholderText("Subject"), { target: { value: "Leak" } });
  fireEvent.change(screen.getByPlaceholderText("Write your message…"), { target: { value: "Water in unit 2" } });
}

describe("one composer, per-role capabilities", () => {
  it("resident: In-app and Email, attach, no schedule, no Text, no draft", () => {
    render(
      <ManagerCommunicationComposeModal
        open
        onClose={vi.fn()}
        portal="resident"
        onSend={vi.fn()}
        liveContacts={[manager]}
        smsUiEnabled
      />,
    );
    expect(toolsFor("In-app")).toBeTruthy();
    expect(toolsFor("Email")).toBeTruthy();
    expect(toolsFor("Text message")).toBeNull();
    expect(scheduleButton()).toBeNull();
    expect(screen.queryByLabelText("Attach files")).toBeTruthy();
    expect(toolsFor("Draft with PropLane")).toBeNull();
  });

  it("vendor: no Text, no schedule, no draft, no channel toggles, attach stays", () => {
    render(
      <ManagerCommunicationComposeModal
        open
        onClose={vi.fn()}
        portal="vendor"
        onSend={vi.fn()}
        liveContacts={[manager]}
        smsUiEnabled
      />,
    );
    expect(toolsFor("Text message")).toBeNull();
    expect(toolsFor("In-app")).toBeNull();
    expect(scheduleButton()).toBeNull();
    expect(toolsFor("Draft with PropLane")).toBeNull();
    expect(screen.queryByLabelText("Attach files")).toBeTruthy();
  });

  it("manager: unchanged tools row (attach, draft, schedule, In-app, Email, Text)", () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ contacts: [] })));
    render(<ManagerCommunicationComposeModal open onClose={vi.fn()} liveContacts={[manager]} smsUiEnabled />);
    expect(screen.queryByLabelText("Attach files")).toBeTruthy();
    expect(toolsFor("Draft with PropLane")).toBeTruthy();
    expect(scheduleButton()).toBeTruthy();
    expect(toolsFor("In-app")).toBeTruthy();
    expect(toolsFor("Email")).toBeTruthy();
    expect(toolsFor("Text message")).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("manager without the SMS UI has no Text toggle", () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ contacts: [] })));
    render(<ManagerCommunicationComposeModal open onClose={vi.fn()} liveContacts={[manager]} />);
    expect(toolsFor("Text message")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("a vendor cannot type an address: only their own list is offered", () => {
    render(
      <ManagerCommunicationComposeModal
        open
        onClose={vi.fn()}
        portal="vendor"
        onSend={vi.fn()}
        liveContacts={[manager]}
      />,
    );
    const to = screen.getByRole("combobox");
    fireEvent.change(to, { target: { value: "someone@else.com" } });
    fireEvent.keyDown(to, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toMatch(/Choose a person from the list/);
  });
});

describe("a refused send keeps the draft and adds nothing", () => {
  it("vendor: onSend false keeps subject, message and the same sendId on retry", async () => {
    const onSend = vi.fn(async () => false);
    const onStageOptimistic = vi.fn();
    const onClose = vi.fn();
    render(
      <ManagerCommunicationComposeModal
        open
        onClose={onClose}
        portal="vendor"
        onSend={onSend}
        onStageOptimistic={onStageOptimistic}
        liveContacts={[manager]}
        senderName="Vic Vendor"
        senderEmail="vic@example.com"
      />,
    );
    await waitFor(() => expect(screen.getByRole("combobox")).toBeTruthy());
    pickManagerAndWrite();

    fireEvent.click(screen.getByRole("button", { name: "Send email" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const first = onSend.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(first).toMatchObject({
      subject: "Leak",
      body: "Water in unit 2",
      directRecipientUserIds: ["user-mgr-1"],
      deliverViaEmail: true,
      deliverViaSms: false,
    });

    // Draft kept, modal not closed, no thread staged by the composer.
    await waitFor(() => expect((screen.getByPlaceholderText("Subject") as HTMLInputElement).value).toBe("Leak"));
    expect((screen.getByPlaceholderText("Write your message…") as HTMLTextAreaElement).value).toBe("Water in unit 2");
    expect(onClose).not.toHaveBeenCalled();
    expect(onStageOptimistic).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Send email" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect((onSend.mock.calls[1]![0] as unknown as { sendId: string }).sendId).toBe(
      (first as { sendId: string }).sendId,
    );
  });

  it("resident: a thrown send keeps the draft; In-app only turns email off", async () => {
    const onSend = vi.fn(async () => {
      throw new Error("network");
    });
    render(
      <ManagerCommunicationComposeModal
        open
        onClose={vi.fn()}
        portal="resident"
        onSend={onSend}
        liveContacts={[manager]}
      />,
    );
    await waitFor(() => expect(screen.getByRole("combobox")).toBeTruthy());
    pickManagerAndWrite();
    // Email off: In-app only.
    fireEvent.click(screen.getByRole("button", { name: "Email" }));
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]![0]).toMatchObject({ deliverViaEmail: false, deliverViaInbox: true, scheduleLater: false });
    await waitFor(() => expect((screen.getByPlaceholderText("Subject") as HTMLInputElement).value).toBe("Leak"));
    expect((screen.getByPlaceholderText("Write your message…") as HTMLTextAreaElement).value).toBe("Water in unit 2");
  });
});
