// @vitest-environment jsdom
import { useEffect, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/components/portal/assistant-shared", () => ({
  AxisAssistantSparkleIcon: () => <svg aria-hidden="true" />,
}));

vi.mock("@/lib/axis-assistant/assistant-conversation-context", () => ({
  AssistantConversationProvider: ({ children, endpoint, storageScope }: {
    children: ReactNode;
    endpoint: string;
    storageScope: string;
  }) => <div data-testid="conversation" data-endpoint={endpoint} data-scope={storageScope}>{children}</div>,
}));

vi.mock("@/components/portal/assistant-dock-panel", () => ({
  AssistantDockPanel: ({ endpoint, contextHint, onCollapse }: {
    endpoint: string;
    contextHint?: string | null;
    onCollapse: () => void;
  }) => (
    <div data-testid="assistant" data-endpoint={endpoint} data-context={contextHint ?? ""}>
      <button type="button" aria-label="Close assistant" onClick={onCollapse}>×</button>
      <input aria-label="Assistant message" />
    </div>
  ),
}));

import { Modal } from "@/components/ui/modal";
import { PortalAssistantConfigProvider } from "@/lib/axis-assistant/portal-assistant-context";

const draftUnmounted = vi.fn();

function Editor() {
  const [draft, setDraft] = useState("");
  useEffect(() => () => { draftUnmounted(); }, []);
  return <input aria-label="Message draft" value={draft} onChange={(event) => setDraft(event.target.value)} />;
}

function Workspace({ dismissBlocked = false, endpoint = "/api/agent/chat" }: {
  dismissBlocked?: boolean;
  endpoint?: string;
}) {
  const [open, setOpen] = useState(true);
  return (
    <PortalAssistantConfigProvider endpoint={endpoint} managerName="Manager">
      <button type="button" onClick={() => setOpen(true)}>Open editor</button>
      <Modal
        open={open}
        title="Compose message"
        description="Write a message to your residents."
        onClose={() => setOpen(false)}
        dismissBlocked={dismissBlocked}
        assistantContext="Compose a resident message"
        assistantStorageScopeKey="compose-message"
      >
        <Editor />
      </Modal>
    </PortalAssistantConfigProvider>
  );
}

beforeEach(() => {
  draftUnmounted.mockClear();
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("modal assistant workspace", () => {
  it("starts with a compact assistant action in the editor header", () => {
    render(<Workspace />);
    const action = screen.getByRole("button", { name: "Ask PropLane" });
    expect(action).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("heading", { name: "Compose message" }).parentElement).toContainElement(action);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("keeps editor and assistant editable within one focus boundary", async () => {
    const user = userEvent.setup();
    render(<Workspace />);
    await user.click(screen.getByRole("button", { name: "Ask PropLane" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    const dialog = screen.getByRole("dialog");
    const draft = screen.getByRole("textbox", { name: "Message draft" });
    const composer = screen.getByRole("textbox", { name: "Assistant message" });
    expect(dialog).toContainElement(draft);
    expect(dialog).toContainElement(composer);
    await user.click(draft);
    expect(draft).toHaveFocus();
    await user.keyboard("Hello residents");
    expect(screen.getByRole("button", { name: "Ask PropLane" })).toHaveAttribute("aria-expanded", "true");
    expect(draft).toHaveValue("Hello residents");
    expect(composer).toBeInTheDocument();
    await user.type(composer, "Make it shorter");
    expect(composer).toHaveFocus();
    await user.click(draft);
    expect(draft).toHaveFocus();
    expect(draft).toHaveValue("Hello residents");
    expect(composer).toHaveValue("Make it shorter");
  });

  it("closes the assistant independently and preserves the editor draft", async () => {
    const user = userEvent.setup();
    render(<Workspace />);
    await user.type(screen.getByRole("textbox", { name: "Message draft" }), "Draft to keep");
    await user.click(screen.getByRole("button", { name: "Ask PropLane" }));
    await user.click(screen.getByRole("button", { name: "Close assistant" }));
    expect(screen.queryByTestId("assistant")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message draft" })).toHaveValue("Draft to keep");
    await waitFor(() => expect(screen.getByRole("button", { name: "Ask PropLane" })).toHaveFocus());
    expect(draftUnmounted).not.toHaveBeenCalled();
  });

  it("discards the mounted editor and its assistant context while keeping the rail open", async () => {
    const user = userEvent.setup();
    render(<Workspace />);
    await user.type(screen.getByRole("textbox", { name: "Message draft" }), "Discard this draft");
    await user.click(screen.getByRole("button", { name: "Ask PropLane" }));
    const originalScope = screen.getByTestId("conversation").getAttribute("data-scope");
    expect(screen.getByTestId("assistant")).toHaveAttribute("data-context", "Compose a resident message");
    await user.click(screen.getByRole("button", { name: "Close", exact: true }));
    expect(screen.queryByRole("textbox", { name: "Message draft" })).not.toBeInTheDocument();
    expect(draftUnmounted).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("assistant")).toHaveAttribute("data-context", "");
    expect(screen.getByTestId("conversation").getAttribute("data-scope")).not.toBe(originalScope);
    expect(screen.getByRole("status")).toHaveTextContent("Editor closed");
    await user.type(screen.getByRole("textbox", { name: "Assistant message" }), "New question");
    await user.click(screen.getByRole("button", { name: "Close assistant" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open editor" }));
    expect(screen.getByRole("textbox", { name: "Message draft" })).toHaveValue("");
    expect(screen.queryByTestId("assistant")).not.toBeInTheDocument();
  });

  it("gives separately mounted detached assistants fresh storage identities", async () => {
    const user = userEvent.setup();
    const first = render(<Workspace />);
    await user.click(screen.getByRole("button", { name: "Ask PropLane" }));
    await user.click(screen.getByRole("button", { name: "Close", exact: true }));
    const firstScope = screen.getByTestId("conversation").getAttribute("data-scope");
    first.unmount();
    render(<Workspace />);
    await user.click(screen.getByRole("button", { name: "Ask PropLane" }));
    await user.click(screen.getByRole("button", { name: "Close", exact: true }));
    expect(screen.getByTestId("conversation").getAttribute("data-scope")).not.toBe(firstScope);
  });

  it.each([true, false])("preserves fullScreenMobile=%s with the assistant closed", (fullScreenMobile) => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    render(<PortalAssistantConfigProvider endpoint="/api/agent/chat" managerName="Manager">
      <Modal open title="Mobile editor" onClose={() => {}} fullScreenMobile={fullScreenMobile}><Editor /></Modal>
    </PortalAssistantConfigProvider>);
    const panel = screen.getByRole("textbox", { name: "Message draft" }).closest(".modal-panel")!;
    expect(panel.className.includes("!max-w-none")).toBe(fullScreenMobile);
    expect(panel.className.includes("native-safe-top")).toBe(true);
  });

  it("preserves fullPage sizing and safe-area padding with the assistant closed", () => {
    render(<PortalAssistantConfigProvider endpoint="/api/agent/chat" managerName="Manager">
      <Modal open title="Full-page editor" onClose={() => {}} fullPage><Editor /></Modal>
    </PortalAssistantConfigProvider>);
    const panel = screen.getByRole("textbox", { name: "Message draft" }).closest(".modal-panel")!;
    expect(panel.className).toContain("!max-w-none");
    expect(panel.className).toContain("!relative");
    expect(panel.className).toContain("native-safe-top");
  });

  it.each(["Escape", "outside", "dialog canvas"])("dismisses both panels via %s", async (method) => {
    const user = userEvent.setup();
    render(<Workspace />);
    await user.click(screen.getByRole("button", { name: "Ask PropLane" }));
    if (method === "Escape") await user.keyboard("{Escape}");
    else if (method === "dialog canvas") await user.click(screen.getByRole("dialog"));
    else {
      fireEvent.pointerDown(document.body, { pointerType: "mouse", button: 0 });
      fireEvent.click(document.body);
    }
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("assistant")).not.toBeInTheDocument();
    expect(draftUnmounted).toHaveBeenCalledTimes(1);
  });

  it("respects dismissBlocked for Escape, outside interaction, canvas clicks, and the editor close", async () => {
    const user = userEvent.setup();
    render(<Workspace dismissBlocked />);
    await user.click(screen.getByRole("button", { name: "Ask PropLane" }));
    await user.keyboard("{Escape}");
    fireEvent.pointerDown(document.body, { pointerType: "mouse", button: 0 });
    fireEvent.click(document.body);
    await user.click(screen.getByRole("dialog"));
    await user.click(screen.getByRole("button", { name: "Close", exact: true }));
    expect(screen.getByRole("textbox", { name: "Message draft" })).toBeInTheDocument();
    expect(screen.getByTestId("assistant")).toBeInTheDocument();
    expect(draftUnmounted).not.toHaveBeenCalled();
  });

  it.each(["/api/agent/resident-chat", "/api/agent/vendor-chat"])("keeps the portal endpoint %s", async (endpoint) => {
    const user = userEvent.setup();
    render(<Workspace endpoint={endpoint} />);
    await user.click(screen.getByRole("button", { name: "Ask PropLane" }));
    expect(screen.getByTestId("conversation")).toHaveAttribute("data-endpoint", endpoint);
    expect(screen.getByTestId("assistant")).toHaveAttribute("data-endpoint", endpoint);
  });
});
