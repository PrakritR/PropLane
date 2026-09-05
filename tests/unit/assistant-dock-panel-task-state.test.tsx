// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ input: "", error: null as string | null, setInput: vi.fn(), send: vi.fn() }));
vi.mock("@/lib/axis-assistant/assistant-conversation-context", () => ({
  useOptionalAssistantConversation: () => ({ ...state, attachments: [], messages: [], ratings: {}, loading: false, multiThread: false }),
}));
import { AssistantDockPanel } from "@/components/portal/assistant-dock-panel";
afterEach(cleanup);
beforeEach(() => { Element.prototype.scrollTo = vi.fn(); state.input = ""; state.error = null; vi.clearAllMocks(); });
it("offers starter prompts that focus the composer without sending", () => {
  render(<AssistantDockPanel compact pinnedComposer />);
  expect(screen.getByRole("heading", { name: "Let’s work on this" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Help me get started" }));
  expect(state.setInput).toHaveBeenCalledWith("Help me get started");
  expect(screen.getByRole("textbox", { name: "Message PropLane Assistant" })).toHaveFocus();
  expect(state.send).not.toHaveBeenCalled();
});
it("shows errors even before a first message exists", () => {
  state.error = "Could not attach that file.";
  render(<AssistantDockPanel compact pinnedComposer />);
  expect(screen.getByRole("alert")).toHaveTextContent(state.error);
});
it("keeps an assistant submission from submitting its parent editor", () => {
  state.input = "Help me draft a reply";
  const parentSubmit = vi.fn();
  render(<div onSubmit={parentSubmit}><AssistantDockPanel compact pinnedComposer contextHint="Communication thread" /></div>);
  fireEvent.submit(screen.getByRole("textbox").closest("form")!);
  expect(state.send).toHaveBeenCalledWith(undefined, { contextHint: "Communication thread" });
  expect(parentSubmit).not.toHaveBeenCalled();
});
