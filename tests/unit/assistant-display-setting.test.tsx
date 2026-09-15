// @vitest-environment jsdom
//
// The manager Settings-page control for the assistant display mode. It writes
// the SAME localStorage preference as the in-assistant pin/unpin buttons.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", email: "mgr@example.com", ready: true }),
}));

let demoActive = false;
let smallViewport = false;

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => demoActive,
}));

vi.mock("@/hooks/use-is-native-app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-is-native-app")>()),
  useIsSmallPortalViewport: () => smallViewport,
}));

import { AssistantDisplaySetting } from "@/components/portal/assistant-display-setting";
import { AxisAssistant } from "@/components/portal/axis-assistant";
import { PortalAssistantDockRail } from "@/components/portal/portal-assistant-dock-rail";
import { readAssistantDisplayMode } from "@/lib/assistant-display-preferences";
import { initAssistantDockState } from "@/lib/axis-assistant/dock-store";

const USER = "mgr-1";

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

const popupBtn = () => document.querySelector('[data-attr="assistant-display-popup"]') as HTMLButtonElement | null;
const dockedBtn = () => document.querySelector('[data-attr="assistant-display-docked"]') as HTMLButtonElement | null;
const rail = () => document.querySelector('[data-attr="portal-assistant-dock-rail"]');

function renderSettings() {
  return render(
    <AxisAssistant managerName="Jordan Lee" dockable>
      <AssistantDisplaySetting />
      <PortalAssistantDockRail managerName="Jordan Lee" />
    </AxisAssistant>,
  );
}

describe("AssistantDisplaySetting", () => {
  beforeEach(() => {
    demoActive = false;
    smallViewport = false;
    window.history.replaceState({}, "", "/portal");
    installFakeStorage();
    initAssistantDockState({ collapsed: true, docked: false });
    Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {});
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("defaults to the floating popup and reflects the stored preference", async () => {
    renderSettings();
    await waitFor(() => expect(popupBtn()).not.toBeNull());
    expect(readAssistantDisplayMode(USER)).toBe("popup");
    expect(popupBtn()!.getAttribute("aria-checked")).toBe("true");
    expect(dockedBtn()!.getAttribute("aria-checked")).toBe("false");
    expect(rail()).toBeNull();
  });

  it("pins to the rail and back, driving readAssistantDisplayMode both ways", async () => {
    renderSettings();
    await waitFor(() => expect(dockedBtn()).not.toBeNull());

    fireEvent.click(dockedBtn()!);
    await waitFor(() => expect(rail()).not.toBeNull());
    expect(readAssistantDisplayMode(USER)).toBe("docked");
    expect(dockedBtn()!.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(popupBtn()!);
    await waitFor(() => expect(rail()).toBeNull());
    expect(readAssistantDisplayMode(USER)).toBe("popup");
    expect(popupBtn()!.getAttribute("aria-checked")).toBe("true");
  });

  it("renders nothing in the /demo sandbox", () => {
    demoActive = true;
    const { container } = renderSettings();
    expect(container.querySelector('[data-attr="assistant-display-popup"]')).toBeNull();
  });

  it("still offers the control on small screens, with no sentence explaining it", async () => {
    smallViewport = true;
    renderSettings();
    await waitFor(() => expect(popupBtn()).not.toBeNull());
    // AGENTS.md § No subtext: the row is its label and control, nothing under it.
    expect(screen.queryByText(/no room for a side panel/i)).toBeNull();
  });

  it("exposes an accessible radiogroup with roving tabindex", async () => {
    renderSettings();
    await waitFor(() => expect(popupBtn()).not.toBeNull());
    expect(screen.getByRole("radiogroup", { name: /assistant display/i })).toBeTruthy();
    expect(popupBtn()!.tabIndex).toBe(0);
    expect(dockedBtn()!.tabIndex).toBe(-1);
  });

  it("shows each option's description as visible text", async () => {
    renderSettings();
    await waitFor(() => expect(popupBtn()).not.toBeNull());
    expect(screen.getByText(/opens the assistant over your work/i)).toBeTruthy();
    expect(screen.getByText(/full-height panel stays open beside the portal/i)).toBeTruthy();
  });
});
