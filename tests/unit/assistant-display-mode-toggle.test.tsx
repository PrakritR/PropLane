// @vitest-environment jsdom
//
// The assistant's presentation preference, driven through the real components a
// manager touches: the named Ask PropLane entry point's popup "pin", the dock's "unpin", and the
// Settings radio group. All three write the SAME persisted preference, and the
// default — nothing stored — must be the popup with NO right rail, so the portal
// content keeps the full width.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", email: "mgr@example.com", ready: true }),
}));

import { AssistantDisplayModeSetting } from "@/components/portal/assistant-display-mode-setting";
import { AxisAssistant } from "@/components/portal/axis-assistant";
import { PortalAssistantDockRail } from "@/components/portal/portal-assistant-dock-rail";
import { PortalTopBar } from "@/components/portal/portal-top-bar";
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

/** The manager portal shell: assistant chrome + the opt-in rail + Settings. */
function renderPortal({ dockable = true }: { dockable?: boolean } = {}) {
  return render(
    <AxisAssistant managerName="Jordan Lee" dockable={dockable}>
      <PortalTopBar kind="pro" basePath="/portal" name="Jordan Lee" email="mgr@example.com" />
      <AssistantDisplayModeSetting />
      <PortalAssistantDockRail managerName="Jordan Lee" />
    </AxisAssistant>,
  );
}

function renderPortalWithTopBar() {
  return render(
    <AxisAssistant managerName="Jordan Lee" dockable>
      <PortalTopBar kind="pro" basePath="/portal" name="Jordan Lee" email="mgr@example.com" />
      <PortalAssistantDockRail managerName="Jordan Lee" />
    </AxisAssistant>,
  );
}

const rail = () => document.querySelector('[data-attr="portal-assistant-dock-rail"]');
const dock = () => document.querySelector('[data-attr="dashboard-assistant-dock"]');
const fab = () => document.querySelector('[data-attr="axis-assistant-fab"]');
const askPropLane = () => document.querySelector<HTMLButtonElement>('[data-attr="portal-ask-proplane"]')!;

describe("assistant display mode", () => {
  beforeEach(() => {
    // `isDemoModeActive()` keys off the pathname, and jsdom starts at "/" —
    // which IS a demo surface. Sit on a real portal route so the dock is offered.
    window.history.replaceState({}, "", "/portal");
    installFakeStorage();
    initAssistantDockState({ collapsed: true, docked: false });
    // jsdom has no layout, so `Element.scrollTo` is missing entirely.
    Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {});
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("defaults to the popup with a bottom-right FAB and no rail", async () => {
    renderPortal();
    expect(askPropLane()).toBeInTheDocument();
    await waitFor(() => expect(fab()).not.toBeNull());
    expect(rail()).toBeNull();
    expect(dock()).toBeNull();
    expect(screen.queryByLabelText("Expand PropLane Assistant")).toBeNull();
  });

  it("toggles the popup closed when Ask PropLane is clicked again", async () => {
    renderPortal();
    fireEvent.click(askPropLane());
    await waitFor(() => expect(document.querySelector(".axis-assistant-panel")).not.toBeNull());
    expect(askPropLane()).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(askPropLane());
    await waitFor(() => expect(document.querySelector(".axis-assistant-panel")).toBeNull());
    expect(askPropLane()).toHaveAttribute("aria-expanded", "false");
  });

  it("pins from the Ask PropLane popup header", async () => {
    renderPortal();
    fireEvent.click(askPropLane());

    const pin = await screen.findByLabelText("Pin PropLane Assistant to the right side");
    fireEvent.click(pin);

    await waitFor(() => expect(rail()).not.toBeNull());
    expect(dock()).not.toBeNull();
    expect(readAssistantDisplayMode(USER)).toBe("docked");
    // The rail itself is desktop-only.
    expect(rail()!.className).toContain("hidden");
    expect(rail()!.className).toContain("lg:flex");
    await waitFor(() => expect(fab()!.className).toContain("lg:hidden"));
  });

  it("opens Ask PropLane in the right-side conversation rail on desktop", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    renderPortalWithTopBar();

    fireEvent.click(screen.getByRole("button", { name: "Ask PropLane" }));

    await waitFor(() => expect(rail()).not.toBeNull());
    await waitFor(() =>
      expect(screen.getByLabelText("Ask the PropLane Assistant about your portfolio")).toHaveFocus(),
    );
    expect(readAssistantDisplayMode(USER)).toBe("docked");
    expect(screen.queryByText("Opening PropLane Assistant")).toBeNull();
  });

  it("keeps the popup panel fixed to its viewport anchor when it opens", async () => {
    renderPortal();
    fireEvent.click(askPropLane());

    await waitFor(() => expect(document.querySelector(".axis-assistant-panel")).not.toBeNull());
    const panel = document.querySelector(".axis-assistant-panel");
    expect(panel).not.toBeNull();
    expect(panel!.className).toContain("fixed");
    expect(panel!.className).not.toContain("relative");
  });

  it("closes from the dock header, back to the popup default", async () => {
    // The rail's header used to offer only an "Unpin" (AppWindow) icon; it now
    // gets a real ✕ close alongside the collapse-to-strip control
    // (PLAN-0920-1058 area 1d), which does the same underlying unpin-to-popup.
    renderPortal();
    fireEvent.click(askPropLane());
    fireEvent.click(await screen.findByLabelText("Pin PropLane Assistant to the right side"));
    await waitFor(() => expect(rail()).not.toBeNull());

    fireEvent.click(screen.getByLabelText("Close PropLane Assistant"));

    await waitFor(() => expect(rail()).toBeNull());
    await waitFor(() => expect(document.querySelector(".axis-assistant-panel")).not.toBeNull());
    expect(readAssistantDisplayMode(USER)).toBe("popup");
  });

  it("collapses the dock rail without reserving a white strip", async () => {
    renderPortal();
    fireEvent.click(askPropLane());
    fireEvent.click(await screen.findByLabelText("Pin PropLane Assistant to the right side"));
    await waitFor(() => expect(dock()).not.toBeNull());

    fireEvent.click(screen.getByLabelText("Collapse PropLane Assistant"));
    await waitFor(() => expect(dock()).toBeNull());
    expect(rail()).toBeNull();
    expect(screen.getByLabelText("Expand PropLane Assistant")).toBeTruthy();
    expect(document.querySelector('[data-attr="portal-assistant-dock-expand"]')?.closest("header")).not.toBeNull();

    fireEvent.click(screen.getByLabelText("Expand PropLane Assistant"));
    await waitFor(() => expect(dock()).not.toBeNull());
  });

  it("switches both ways from Settings, and the choice survives a remount", async () => {
    const first = renderPortal();
    const docked = await screen.findByRole("radio", { name: /Pinned to the right/ });
    expect(docked).toHaveProperty("ariaChecked", "false");
    fireEvent.click(docked);

    await waitFor(() => expect(rail()).not.toBeNull());
    expect(readAssistantDisplayMode(USER)).toBe("docked");

    // A reload reads the stored preference back. The harness remounts with
    // the default collapsed cookie, so the docked choice must still be on
    // (expand control in the top bar) even when the panel itself is folded.
    first.unmount();
    renderPortal();
    await waitFor(() =>
      expect(screen.getByLabelText("Expand PropLane Assistant")).toBeTruthy(),
    );
    expect(rail()).toBeNull();
    expect(
      await screen.findByRole("radio", { name: /Pinned to the right/ }),
    ).toHaveProperty("ariaChecked", "true");

    fireEvent.click(screen.getByRole("radio", { name: /Floating popup/ }));
    await waitFor(() => expect(rail()).toBeNull());
    expect(readAssistantDisplayMode(USER)).toBe("popup");
  });

  it("offers no dock affordance in a portal that did not opt in", async () => {
    renderPortal({ dockable: false });
    expect(askPropLane()).toBeInTheDocument();

    // No Settings toggle...
    expect(screen.queryByRole("radio", { name: /Pinned to the right/ })).toBeNull();
    // ...and no pin control in the popup.
    fireEvent.click(askPropLane());
    await screen.findByText("PropLane Assistant");
    expect(screen.queryByLabelText("Pin PropLane Assistant to the right side")).toBeNull();

    // Even a preference stored by another surface cannot summon the rail here.
    expect(rail()).toBeNull();
  });
});
