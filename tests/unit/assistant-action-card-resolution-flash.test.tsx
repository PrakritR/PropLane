// @vitest-environment jsdom
//
// M013 — task-step resolution morph on assistant action cards. The pending
// action card resolving used to just unmount with no transition at all; now
// a brief settle-pop + drawn checkmark/x flash renders in the same slot —
// but only once the real resolvePendingAction call has actually landed
// (never on click, and never for a failed resolution).
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  input: "",
  error: null as string | null,
  pendingAction: null as null | {
    id: string;
    preview: { title: string; fields: []; confirmLabel: string; kind: string };
  },
  setInput: vi.fn(),
  send: vi.fn(),
  resolvePendingAction: vi.fn(),
}));

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
beforeEach(() => {
  Element.prototype.scrollTo = vi.fn();
  state.input = "";
  state.error = null;
  state.pendingAction = null;
  vi.clearAllMocks();
});

function pendingAction(title = "Record $50 expense") {
  return { id: "act-1", preview: { title, fields: [] as [], confirmLabel: "Record", kind: "record_expense" } };
}

it("shows no resolution flash while the card is still pending", () => {
  state.pendingAction = pendingAction();
  render(<AssistantDockPanel pinnedComposer />);
  expect(screen.getByText("Record $50 expense")).toBeInTheDocument();
  expect(document.querySelector(".motion-resolved-flash")).toBeNull();
});

it("flashes Done in the card's own slot once a confirm genuinely resolves — never before", async () => {
  state.pendingAction = pendingAction();
  const { rerender } = render(<AssistantDockPanel pinnedComposer />);

  fireEvent.click(screen.getByRole("button", { name: "Record" }));
  expect(state.resolvePendingAction).toHaveBeenCalledWith("confirm");
  // The click alone must not claim success.
  expect(document.querySelector(".motion-resolved-flash")).toBeNull();

  // The real resolution lands: pendingAction clears, no error.
  state.pendingAction = null;
  rerender(<AssistantDockPanel pinnedComposer />);

  await waitFor(() => expect(document.querySelector(".motion-resolved-flash")).not.toBeNull());
  expect(screen.getByText(/Record \$50 expense · Done/)).toBeInTheDocument();
});

it("flashes Cancelled for a deny resolution", async () => {
  state.pendingAction = pendingAction("Remove co-manager");
  const { rerender } = render(<AssistantDockPanel pinnedComposer />);

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(state.resolvePendingAction).toHaveBeenCalledWith("deny");

  state.pendingAction = null;
  rerender(<AssistantDockPanel pinnedComposer />);

  await waitFor(() => expect(document.querySelector(".motion-resolved-flash")).not.toBeNull());
  expect(screen.getByText(/Remove co-manager · Cancelled/)).toBeInTheDocument();
});

it("never flashes Done for a resolution that actually failed", async () => {
  state.pendingAction = pendingAction();
  const { rerender } = render(<AssistantDockPanel pinnedComposer />);

  fireEvent.click(screen.getByRole("button", { name: "Record" }));

  // A non-retryable failure clears pendingAction too, but sets error in the
  // same pass (use-assistant-conversation.ts's own contract) — must never
  // read as "Done".
  state.pendingAction = null;
  state.error = "Could not complete that action.";
  rerender(<AssistantDockPanel pinnedComposer />);

  await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  expect(document.querySelector(".motion-resolved-flash")).toBeNull();
});

it("clears the flash on its own after a beat, without leaving stale chrome behind", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  state.pendingAction = pendingAction();
  const { rerender } = render(<AssistantDockPanel pinnedComposer />);
  fireEvent.click(screen.getByRole("button", { name: "Record" }));
  state.pendingAction = null;
  rerender(<AssistantDockPanel pinnedComposer />);
  await vi.waitFor(() => expect(document.querySelector(".motion-resolved-flash")).not.toBeNull());
  vi.advanceTimersByTime(1200);
  await vi.waitFor(() => expect(document.querySelector(".motion-resolved-flash")).toBeNull());
  vi.useRealTimers();
});
