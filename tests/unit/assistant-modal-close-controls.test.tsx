// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Modal } from "@/components/ui/modal";
import { PortalAssistantConfigProvider } from "@/lib/axis-assistant/portal-assistant-context";

/**
 * PRP-310 — independent close controls, outside-click dismissal, and typed
 * send confirmation, exercised through the REAL shared Modal, the real
 * ModalAssistantStrip, the real AssistantDockPanel and the real composer.
 * Only `fetch` is simulated. `modal-assistant-workspace.test.tsx` covers the
 * same workspace with the assistant panel mocked out; this suite proves the
 * shipped panel's own close control and composer behave the same way.
 */

const PENDING = {
  id: "proposal-1",
  preview: {
    kind: "send_message",
    title: "Send message",
    confirmLabel: "Send",
    fields: [
      { label: "To", value: "jordan@example.com" },
      { label: "Message", value: "Hi Jordan, the plumber is booked for Tuesday." },
    ],
  },
};

type Recorded = { url: string; body: Record<string, unknown> };

function installFetch() {
  const calls: Recorded[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url: String(input), body });
      const payload = body.confirmActionId
        ? { reply: "Message sent." }
        : body.denyActionId
          ? { reply: "Discarded." }
          : { reply: "Here is a draft.", pendingAction: PENDING };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
  return calls;
}

const draftUnmounted = vi.fn();

function Editor() {
  const [draft, setDraft] = useState("");
  useEffect(() => () => { draftUnmounted(); }, []);
  return <textarea aria-label="Message draft" value={draft} onChange={(event) => setDraft(event.target.value)} />;
}

function Workspace({ onClosed }: { onClosed?: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <PortalAssistantConfigProvider endpoint="/api/agent/chat" managerName="Morgan Manager">
      <Modal
        open={open}
        title="New message"
        description="Write to a resident."
        onClose={() => { setOpen(false); onClosed?.(); }}
        assistantContext="Compose message · To: jordan@example.com"
        assistantStorageScopeKey="compose-message"
      >
        <Editor />
      </Modal>
    </PortalAssistantConfigProvider>
  );
}

const editorClose = () => screen.getByRole("button", { name: "Close", exact: true });
const assistantClose = () => screen.getByRole("button", { name: "Close PropLane Assistant" });
const askProPlane = () => screen.getByRole("button", { name: "Ask PropLane" });
const composer = () => screen.getByRole("textbox", { name: "Ask the PropLane Assistant about your portfolio" });
const draft = () => screen.getByRole("textbox", { name: "Message draft" });

beforeEach(() => {
  draftUnmounted.mockClear();
  localStorage.clear();
  sessionStorage.clear();
  // jsdom implements neither; the real dock panel scrolls its transcript on every turn.
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { value: vi.fn(), configurable: true, writable: true });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("modal assistant close controls (real panel)", () => {
  it("gives the editor and the assistant their own labeled close controls", async () => {
    installFetch();
    const user = userEvent.setup();
    render(<Workspace />);
    await user.click(askProPlane());
    const editorX = editorClose();
    const assistantX = assistantClose();
    expect(editorX).not.toBe(assistantX);
    expect(assistantX).toHaveAttribute("data-attr", "modal-assistant-close");
    expect(screen.queryByRole("button", { name: "Collapse PropLane Assistant" })).not.toBeInTheDocument();
    // Both live inside the one dialog boundary so Radix never treats either as "outside".
    const dialog = screen.getByRole("dialog");
    expect(dialog).toContainElement(editorX);
    expect(dialog).toContainElement(assistantX);
  });

  it("closing the assistant keeps the editor, its draft, and returns focus to the CTA", async () => {
    installFetch();
    const user = userEvent.setup();
    render(<Workspace />);
    await user.type(draft(), "Keep this draft");
    await user.click(askProPlane());
    await user.type(composer(), "unsent question");
    await user.click(assistantClose());
    expect(screen.queryByRole("complementary", { name: "PropLane Assistant" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(draft()).toHaveValue("Keep this draft");
    expect(draftUnmounted).not.toHaveBeenCalled();
    await waitFor(() => expect(askProPlane()).toHaveFocus());
    expect(askProPlane()).toHaveAttribute("aria-expanded", "false");
  });

  it("closing the editor keeps the assistant open on a fresh, context-free thread", async () => {
    installFetch();
    const user = userEvent.setup();
    const onClosed = vi.fn();
    render(<Workspace onClosed={onClosed} />);
    await user.click(askProPlane());
    await user.click(editorClose());
    expect(screen.queryByRole("textbox", { name: "Message draft" })).not.toBeInTheDocument();
    expect(draftUnmounted).toHaveBeenCalledTimes(1);
    expect(onClosed).not.toHaveBeenCalled();
    expect(screen.getByRole("complementary", { name: "PropLane Assistant" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Editor closed");
    expect(composer()).toBeInTheDocument();
    // The assistant's X is now the last panel standing, so it ends the overlay.
    await user.click(assistantClose());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it("a pointer-down outside both panels dismisses both", async () => {
    installFetch();
    const user = userEvent.setup();
    const onClosed = vi.fn();
    render(<Workspace onClosed={onClosed} />);
    await user.type(draft(), "Will be discarded");
    await user.click(askProPlane());
    fireEvent.pointerDown(document.body, { pointerType: "mouse", button: 0 });
    fireEvent.click(document.body);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "PropLane Assistant" })).not.toBeInTheDocument();
    expect(draftUnmounted).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it("a pointer-down inside the assistant rail is not an outside click", async () => {
    installFetch();
    const user = userEvent.setup();
    const onClosed = vi.fn();
    render(<Workspace onClosed={onClosed} />);
    await user.click(askProPlane());
    const rail = screen.getByRole("complementary", { name: "PropLane Assistant" });
    fireEvent.pointerDown(rail, { pointerType: "mouse", button: 0 });
    fireEvent.click(rail);
    fireEvent.pointerDown(composer(), { pointerType: "mouse", button: 0 });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(rail).toBeInTheDocument();
    expect(onClosed).not.toHaveBeenCalled();
  });

  it("Escape still dismisses both panels", async () => {
    installFetch();
    const user = userEvent.setup();
    const onClosed = vi.fn();
    render(<Workspace onClosed={onClosed} />);
    await user.click(askProPlane());
    await user.click(composer());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "PropLane Assistant" })).not.toBeInTheDocument();
    expect(onClosed).toHaveBeenCalledTimes(1);
  });
});

describe("typed send confirmation through the real composer", () => {
  it("typing 'yes, send' confirms the one pending message with only its action id", async () => {
    const calls = installFetch();
    const user = userEvent.setup();
    render(<Workspace />);
    await user.click(askProPlane());
    await user.type(composer(), "draft a reply about the plumber{Enter}");
    await screen.findByText("Send message");
    expect(screen.getByText("Hi Jordan, the plumber is booked for Tuesday.")).toBeInTheDocument();
    expect(calls).toHaveLength(1);

    await user.type(composer(), "yes, send{Enter}");
    await screen.findByText("Message sent.");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe("/api/agent/chat");
    expect(calls[1]!.body).toEqual({ confirmActionId: "proposal-1" });
    expect(screen.queryByText("Send message")).not.toBeInTheDocument();
    // The command itself is not a user bubble — it was an approval, not a message.
    expect(screen.queryByText("yes, send")).not.toBeInTheDocument();
    expect(composer()).toHaveValue("");
  });

  it("any other text while a preview is pending is an ordinary message that drops the stale card", async () => {
    const calls = installFetch();
    const user = userEvent.setup();
    render(<Workspace />);
    await user.click(askProPlane());
    await user.type(composer(), "draft a reply{Enter}");
    await screen.findByText("Send message");
    await user.type(composer(), "send it after changing Tuesday to Wednesday{Enter}");
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.body).not.toHaveProperty("confirmActionId");
    expect(calls[1]!.body.messages).toEqual([
      { role: "user", content: "draft a reply" },
      { role: "assistant", content: "Here is a draft." },
      { role: "user", content: "send it after changing Tuesday to Wednesday" },
    ]);
  });

  it("a typed send with nothing pending is a normal message", async () => {
    const calls = installFetch();
    const user = userEvent.setup();
    render(<Workspace />);
    await user.click(askProPlane());
    await user.type(composer(), "send{Enter}");
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).not.toHaveProperty("confirmActionId");
    expect(calls[0]!.body.messages).toEqual([{ role: "user", content: "send" }]);
  });
});
