// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ASSISTANT_DOCK_INPUT_ID } from "@/components/portal/assistant-dock-input-id";
import { Modal } from "@/components/ui/modal";
import { shouldHideAssistantFab } from "@/lib/axis-assistant/fab-visibility";
import { closeAxisAssistant, getAxisAssistantOpen, openAxisAssistant } from "@/lib/axis-assistant/open-store";
import { PortalAssistantConfigProvider } from "@/lib/axis-assistant/portal-assistant-context";

/**
 * PRP-310 — phone behaviour. Below `lg` the portal never lays out the right
 * rail (no `ASSISTANT_DOCK_INPUT_ID` composer exists), so the strip's own
 * presentation is the assistant: a full-width sheet over the editor, opened
 * with the SAME task context and the SAME close semantics as the desktop rail.
 * The floating popup is arbitrated away rather than stacked underneath: the
 * FAB hides while a task assistant is active and an already-open popup closes.
 */
const CONTEXT = "Add co-manager · Invite: sam@example.com";

type Recorded = { body: Record<string, unknown> };

function installFetch() {
  const calls: Recorded[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ reply: "Sure — what should the invite say?" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return calls;
}

function PhoneWorkspace({ onClosed }: { onClosed?: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <PortalAssistantConfigProvider endpoint="/api/agent/chat" managerName="Morgan Manager">
      <Modal
        open={open}
        title="Add co-manager"
        onClose={() => { setOpen(false); onClosed?.(); }}
        assistantContext={CONTEXT}
        assistantStorageScopeKey="add-co-manager"
      >
        <input aria-label="Co-manager email" defaultValue="" />
      </Modal>
    </PortalAssistantConfigProvider>
  );
}

const askProPlane = () => screen.getByRole("button", { name: "Ask PropLane" });
const rail = () => screen.getByRole("complementary", { name: "PropLane Assistant" });
const composer = () => screen.getByRole("textbox", { name: "Ask the PropLane Assistant about your portfolio" });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  // jsdom does not implement it; the real dock panel scrolls its transcript on every turn.
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { value: vi.fn(), configurable: true, writable: true });
  // Every media query the modal and strip consult reads as a phone.
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});

afterEach(() => {
  cleanup();
  closeAxisAssistant();
  vi.unstubAllGlobals();
});

describe("modal assistant strip on a phone", () => {
  it("opens the assistant in place of the (unmounted) dock, closing the popup and hiding the FAB", async () => {
    installFetch();
    const user = userEvent.setup();
    openAxisAssistant();
    expect(getAxisAssistantOpen()).toBe(true);
    render(<PhoneWorkspace />);
    expect(document.getElementById(ASSISTANT_DOCK_INPUT_ID)).toBeNull();
    expect(shouldHideAssistantFab()).toBe(false);

    await user.click(askProPlane());

    expect(rail()).toBeInTheDocument();
    expect(rail().className).toContain("w-full");
    expect(screen.getByRole("dialog")).toContainElement(rail());
    expect(getAxisAssistantOpen()).toBe(false);
    expect(shouldHideAssistantFab()).toBe(true);
    expect(document.getElementById(ASSISTANT_DOCK_INPUT_ID)).toBeNull();
  });

  it("sends the same task context as the desktop rail", async () => {
    const calls = installFetch();
    const user = userEvent.setup();
    render(<PhoneWorkspace />);
    await user.click(askProPlane());
    await user.type(composer(), "Help me invite Sam{Enter}");
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body.contextHint).toBe(CONTEXT);
    expect(calls[0]!.body.messages).toEqual([{ role: "user", content: "Help me invite Sam" }]);
    expect(document.body.textContent).not.toContain("Invite: sam@example.com");
  });

  it("keeps the same close semantics: assistant X returns to the editor, Escape ends both", async () => {
    installFetch();
    const user = userEvent.setup();
    const onClosed = vi.fn();
    render(<PhoneWorkspace onClosed={onClosed} />);
    await user.type(screen.getByRole("textbox", { name: "Co-manager email" }), "sam@example.com");
    await user.click(askProPlane());
    await user.click(screen.getByRole("button", { name: "Close PropLane Assistant" }));
    expect(screen.queryByRole("complementary", { name: "PropLane Assistant" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Co-manager email" })).toHaveValue("sam@example.com");
    expect(shouldHideAssistantFab()).toBe(false);
    await waitFor(() => expect(askProPlane()).toHaveFocus());
    expect(onClosed).not.toHaveBeenCalled();

    await user.click(askProPlane());
    await user.click(composer());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(shouldHideAssistantFab()).toBe(false);
  });
});
