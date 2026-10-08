// @vitest-environment jsdom
//
// "Be consistent with Ask PropLane" (captain, Oct 7): the assistant panel is ONE
// panel. Its header is `AssistantPanelHeader` everywhere - ✦ tile, PropLane,
// New, History, close - whether it opens as the popup, the docked rail, or the
// rail inside a pop-up. And the in-dialog entry point is the same ghost icon
// action every other utility control uses, never a labeled outline pill.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ userId: "mgr-1", email: "mgr@example.com", ready: true }),
}));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", email: "mgr@example.com", ready: true }),
}));

import { AxisAssistant } from "@/components/portal/axis-assistant";
import { PortalAssistantDockRail } from "@/components/portal/portal-assistant-dock-rail";
import { PortalTopBar } from "@/components/portal/portal-top-bar";
import { Modal } from "@/components/ui/modal";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { proPortal } from "@/lib/portals/pro";
import { setAssistantDisplayMode } from "@/lib/assistant-display-preferences";
import {
  archiveScopedThread,
  deleteScopedThread,
  loadScopedThreads,
  newScopedThreadId,
} from "@/lib/axis-assistant/assistant-chat-storage";
import { useAssistantConversation } from "@/lib/axis-assistant/use-assistant-conversation";
import { initAssistantDockState } from "@/lib/axis-assistant/dock-store";
import { PortalAssistantConfigProvider } from "@/lib/axis-assistant/portal-assistant-context";

function installFakeStorage() {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

const NEW = { name: "Start a new conversation" };
const HISTORY = { name: "Past conversations" };

function expectFullHeader(scope: HTMLElement, closeName: string | RegExp) {
  const utils = within(scope);
  expect(utils.getByRole("button", NEW)).toHaveTextContent("New");
  expect(utils.getByRole("button", HISTORY)).toHaveTextContent("History");
  expect(utils.getByRole("button", { name: closeName })).toBeInTheDocument();
  expect(scope.textContent).toContain("PropLane");
}

beforeEach(() => {
  window.history.replaceState({}, "", "/portal");
  installFakeStorage();
  initAssistantDockState({ collapsed: true, docked: false });
  Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {});
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
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

describe("one assistant header in every context", () => {
  it("popup: New, History and close, with no conversation yet", async () => {
    render(
      <AppUiProvider>
        <AxisAssistant managerName="Jordan Lee" dockable>
          <PortalTopBar kind="pro" basePath="/portal" definition={proPortal} name="Jordan Lee" email="mgr@example.com" />
        </AxisAssistant>
      </AppUiProvider>,
    );
    fireEvent.click(document.querySelector('[data-attr="portal-assistant-panel"]')!);
    const panel = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".axis-assistant-panel");
      expect(el).not.toBeNull();
      return el!;
    });
    await within(panel).findByRole("button", NEW);
    expectFullHeader(panel, "Close PropLane Assistant");
  });

  it("dock: New, History and close", async () => {
    setAssistantDisplayMode("mgr-1", "docked");
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    render(
      <AppUiProvider>
        <AxisAssistant managerName="Jordan Lee" dockable>
          <PortalTopBar kind="pro" basePath="/portal" definition={proPortal} name="Jordan Lee" email="mgr@example.com" />
          <PortalAssistantDockRail managerName="Jordan Lee" />
        </AxisAssistant>
      </AppUiProvider>,
    );
    fireEvent.click(document.querySelector('[data-attr="portal-assistant-panel"]')!);
    const rail = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-attr="portal-assistant-dock-rail"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expectFullHeader(rail, "Close PropLane Assistant");
  });

  it("in a pop-up: the same header, and History opens the past-conversations panel", async () => {
    const user = userEvent.setup();
    render(
      <PortalAssistantConfigProvider endpoint="/api/agent/chat" managerName="Jordan Lee">
        <Modal open title="Tour availability" onClose={() => {}} assistantContext="Tour availability" assistantStorageScopeKey="tour-availability">
          <p>Calendar</p>
        </Modal>
      </PortalAssistantConfigProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Ask PropLane" }));
    const rail = document.querySelector<HTMLElement>('[data-attr="modal-assistant-rail"]')!;
    expect(rail).not.toBeNull();
    expectFullHeader(rail, "Close PropLane Assistant");

    await user.click(within(rail).getByRole("button", HISTORY));
    expect(await screen.findByRole("dialog", { name: "Past conversations" })).toBeInTheDocument();
  });
});

describe("the in-dialog entry point is utility chrome", () => {
  it("is a ghost icon action named Ask PropLane - not a labeled pill", () => {
    render(
      <PortalAssistantConfigProvider endpoint="/api/agent/chat" managerName="Jordan Lee">
        <Modal open title="Tour availability" onClose={() => {}} assistantContext="Tour availability" assistantStorageScopeKey="tour-availability">
          <p>Calendar</p>
        </Modal>
      </PortalAssistantConfigProvider>,
    );
    const entry = screen.getByRole("button", { name: "Ask PropLane" });
    expect(entry).toHaveAttribute("data-slot", "portal-icon-action");
    expect(entry).toHaveAttribute("data-attr", "modal-assistant-expand");
    expect(entry).toHaveAttribute("aria-expanded", "false");
    // The word is the accessible name and tooltip only: nothing is drawn.
    expect(entry.textContent?.trim()).toBe("");
    expect(entry.className).not.toMatch(/rounded-full|border-primary/);
    expect(entry.querySelector("svg")).not.toBeNull();
  });
});

describe("a task assistant's History", () => {
  it("keeps the thread New replaces, restores it, and forgets a deleted one", () => {
    const endpoint = "/api/agent/chat";
    const scope = "modal:tour-availability";
    const first = [
      { role: "user" as const, content: "Close Tuesdays" },
      { role: "assistant" as const, content: "Done." },
    ];
    const second = [{ role: "user" as const, content: "Open Saturdays" }];
    const firstId = newScopedThreadId();
    const secondId = newScopedThreadId();
    archiveScopedThread(endpoint, scope, first, firstId);
    archiveScopedThread(endpoint, scope, second, secondId);
    // Re-archiving the SAME thread refreshes it instead of duplicating it.
    archiveScopedThread(endpoint, scope, [...first, { role: "user", content: "Thanks" }], firstId);
    expect(loadScopedThreads(endpoint, scope).map((t) => t.title)).toEqual(["Close Tuesdays", "Open Saturdays"]);
    // Another modal's history is separate.
    expect(loadScopedThreads(endpoint, "modal:other")).toEqual([]);
    // An empty conversation is never saved.
    archiveScopedThread(endpoint, scope, [], newScopedThreadId());
    expect(loadScopedThreads(endpoint, scope)).toHaveLength(2);

    deleteScopedThread(endpoint, scope, secondId);
    expect(loadScopedThreads(endpoint, scope).map((t) => t.title)).toEqual(["Close Tuesdays"]);
  });

  it("keeps two threads that open with the same prompt apart", () => {
    const endpoint = "/api/agent/chat";
    const scope = "modal:same-prompt";
    const opener = [{ role: "user" as const, content: "Draft a reply to this tenant" }];
    const earlier = newScopedThreadId();
    const later = newScopedThreadId();
    archiveScopedThread(endpoint, scope, [...opener, { role: "assistant", content: "First draft." }], earlier);
    archiveScopedThread(endpoint, scope, [...opener, { role: "assistant", content: "Second draft." }], later);
    expect(loadScopedThreads(endpoint, scope)).toHaveLength(2);
    // Deleting one leaves the other, which a shared id would not.
    deleteScopedThread(endpoint, scope, later);
    expect(loadScopedThreads(endpoint, scope).map((t) => t.messages[1]?.content)).toEqual(["First draft."]);
  });
});

describe("a task conversation's History actions", () => {
  it("lists saved threads, restores one, and New files the live thread away", async () => {
    const endpoint = "/api/agent/chat";
    archiveScopedThread(
      endpoint,
      "modal:tour-availability",
      [
        { role: "user", content: "Close Tuesdays" },
        { role: "assistant", content: "Done." },
      ],
      newScopedThreadId(),
    );
    const { result } = renderHook(() =>
      useAssistantConversation(endpoint, { storageScope: "modal:tour-availability:3", historyScope: "modal:tour-availability" }),
    );
    expect(result.current.messages).toEqual([]);

    act(() => result.current.openHistory());
    expect(result.current.historyOpen).toBe(true);
    expect(result.current.threads.map((t) => t.title)).toEqual(["Close Tuesdays"]);

    const chosenId = result.current.threads[0]!.id;
    await act(() => result.current.selectThread(chosenId));
    expect(result.current.historyOpen).toBe(false);
    expect(result.current.messages.map((m) => m.content)).toEqual(["Close Tuesdays", "Done."]);
    expect(result.current.activeThreadId).toBe(chosenId);

    await act(() => result.current.startNewChat());
    expect(result.current.messages).toEqual([]);
    expect(loadScopedThreads(endpoint, "modal:tour-availability")).toHaveLength(1);
  });
});
