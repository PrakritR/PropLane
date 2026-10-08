// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeAxisAssistant,
  getAxisAssistantOpen,
  openAxisAssistant,
  sendAxisAssistantPrompt,
  setAxisAssistantOpen,
  subscribeAxisAssistantOpen,
  subscribeAxisAssistantPrompt,
} from "@/lib/axis-assistant/open-store";
import {
  collapseAssistantDock,
  getAssistantDockCollapsed,
  initAssistantDockState,
} from "@/lib/axis-assistant/dock-store";

function stubViewport(small: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("max-width") ? small : !small,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, "", "/portal");
  setAxisAssistantOpen(false);
  initAssistantDockState({ collapsed: true });
});

afterEach(() => {
  collapseAssistantDock();
  vi.unstubAllGlobals();
});

describe("axis-assistant open-store", () => {
  it("below lg, opens the full-screen sheet and notifies subscribers", () => {
    stubViewport(true);
    const seen: boolean[] = [];
    const unsubscribe = subscribeAxisAssistantOpen(() => {
      seen.push(getAxisAssistantOpen());
    });

    openAxisAssistant();
    expect(getAxisAssistantOpen()).toBe(true);
    expect(getAssistantDockCollapsed()).toBe(true);
    expect(seen).toEqual([true]);

    closeAxisAssistant();
    expect(getAxisAssistantOpen()).toBe(false);
    expect(seen).toEqual([true, false]);

    unsubscribe();
  });

  it("at lg and up, opens the side panel and never a pop-up", () => {
    stubViewport(false);
    openAxisAssistant();
    expect(getAssistantDockCollapsed()).toBe(false);
    expect(getAxisAssistantOpen()).toBe(false);
  });

  it("remembers the side panel open/closed per device, and survives storage that throws", () => {
    stubViewport(false);
    openAxisAssistant();
    expect(window.localStorage.getItem("axis:assistant-panel-open:v1")).toBe("1");
    // A new page load: the server hint says closed, this device's choice wins.
    initAssistantDockState({ collapsed: true });
    expect(getAssistantDockCollapsed()).toBe(false);

    collapseAssistantDock();
    expect(window.localStorage.getItem("axis:assistant-panel-open:v1")).toBe("0");

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => openAxisAssistant()).not.toThrow();
    expect(getAssistantDockCollapsed()).toBe(false);
    expect(() => initAssistantDockState({ collapsed: true })).not.toThrow();
    vi.restoreAllMocks();
  });

  it("ignores a stored legacy pop-up preference", () => {
    window.localStorage.setItem("axis:assistant-display-mode:v1:mgr-1", "popup");
    stubViewport(false);
    openAxisAssistant();
    expect(getAssistantDockCollapsed()).toBe(false);
    expect(getAxisAssistantOpen()).toBe(false);
  });

  it("sendAxisAssistantPrompt opens the right surface and hands the prompt to the conversation", () => {
    const received: string[] = [];
    const unsubscribe = subscribeAxisAssistantPrompt((prompt) => received.push(prompt));

    stubViewport(false);
    sendAxisAssistantPrompt("Who is late on rent?");
    expect(getAssistantDockCollapsed()).toBe(false);

    stubViewport(true);
    sendAxisAssistantPrompt("Any open services?");
    expect(getAxisAssistantOpen()).toBe(true);

    expect(received).toEqual(["Who is late on rent?", "Any open services?"]);
    unsubscribe();
  });
});
