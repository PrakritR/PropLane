// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ input: "", error: null as string | null, setInput: vi.fn(), send: vi.fn() }));
vi.mock("@/lib/axis-assistant/assistant-conversation-context", () => ({
  useOptionalAssistantConversation: () => ({
    ...state,
    attachments: [],
    messages: [],
    ratings: {},
    loading: false,
    multiThread: false,
    hydrateArchive: vi.fn(),
  }),
}));
import { AssistantDockPanel } from "@/components/portal/assistant-dock-panel";
afterEach(cleanup);
beforeEach(() => { Element.prototype.scrollTo = vi.fn(); state.input = ""; state.error = null; vi.clearAllMocks(); });

// A modal rail is the SAME panel as the portal dock — one header, one empty
// state, one composer. Only the empty-state subline is task-specific.
it("shows the shared assistant empty state inside a modal rail", () => {
  render(<AssistantDockPanel managerName="Jordan Lee" pinnedComposer composerHint="Type in chat to edit the lease." />);
  expect(screen.getByText("PropLane Assistant")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Hi Jordan," })).toBeInTheDocument();
  expect(screen.getByText("Type in chat to edit the lease.")).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Ask the PropLane Assistant about your portfolio" })).toBeInTheDocument();
});

it("sends a suggestion chip with the surface's context hint", () => {
  render(<AssistantDockPanel pinnedComposer contextHint="Communication thread" />);
  fireEvent.click(screen.getByRole("button", { name: /Late on rent/ }));
  expect(state.send).toHaveBeenCalledWith("Who is late on rent right now?", { contextHint: "Communication thread" });
});

it("shows errors even before a first message exists", () => {
  state.error = "Could not attach that file.";
  render(<AssistantDockPanel pinnedComposer />);
  expect(screen.getByRole("alert")).toHaveTextContent(state.error);
});

it("keeps an assistant submission from submitting its parent editor", () => {
  state.input = "Help me draft a reply";
  const parentSubmit = vi.fn();
  render(<div onSubmit={parentSubmit}><AssistantDockPanel pinnedComposer contextHint="Communication thread" /></div>);
  fireEvent.submit(screen.getByRole("textbox").closest("form")!);
  expect(state.send).toHaveBeenCalledWith(undefined, { contextHint: "Communication thread" });
  expect(parentSubmit).not.toHaveBeenCalled();
});
