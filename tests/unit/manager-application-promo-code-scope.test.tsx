/** @vitest-environment jsdom */
/**
 * A promo code lives on ONE property.
 *
 * The codes table is unique on (manager, code text), so the same code cannot
 * sit on two listings. The Applications panel nevertheless offered a
 * multi-property selection, promised "any of the N selected properties", and
 * replayed the field's value on every PATCH — including automation-only saves.
 * Selecting three houses and typing a code wrote it to the first, 400'd on the
 * second ("already in use on another property"), and broke the loop; the same
 * replay meant an ordinary auto-approve toggle stopped saving partway down the
 * selection for a manager who had ever set a code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast }),
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));
vi.mock("@/hooks/use-manager-user-id", () => ({ useManagerUserId: () => ({ userId: "mgr-1" }) }));
vi.mock("@/hooks/use-work-assignment-directory", () => ({
  useWorkAssignmentDirectory: () => ({ teamMembers: [] }),
}));

import { SettingsModulePage } from "@/components/portal/settings-module-page";
import { ProPortalSettingsModal } from "@/components/portal/pro-portal-settings-modal";

const PROPERTY_OPTIONS = [
  { id: "prop-1", label: "Ballard House" },
  { id: "prop-2", label: "Fremont Flat" },
  { id: "prop-3", label: "Queen Anne Loft" },
];

let patches: Array<Record<string, unknown>>;
let storedCodes: Map<string, string | null>;

beforeEach(() => {
  vi.clearAllMocks();
  patches = [];
  storedCodes = new Map([["prop-1", "WELCOME50"]]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("manager-application-settings") && (init?.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify({ automation: { autoApproveApplications: false }, waiverCode: storedCodes.get(new URL(url, "http://localhost").searchParams.get("propertyId") ?? "prop-1") ?? null }),
          { status: 200 },
        );
      }
      if (url.includes("manager-application-settings") && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        patches.push(body);
        if ("waiverCode" in body) {
          const code = String(body.waiverCode).trim().toUpperCase().replace(/\s+/g, "") || null;
          storedCodes.set(String(body.propertyId), code);
          return new Response(JSON.stringify({ waiverCode: code }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderModal(onClose = () => undefined) {
  return render(
    <ProPortalSettingsModal
      open
      onClose={onClose}
      initialTab="applications"
      // The promo code + automation toggles live on the Automation pane; the
      // Form pane is the question-template editor. Real callers that open
      // this modal for application settings (e.g. the property Application
      // tab's own settings gear) pass this explicitly — match that here.
      initialPane="automation"
      initialPropertyId={PROPERTY_OPTIONS[0].id}
      propertyOptions={PROPERTY_OPTIONS}
    />,
  );
}

// The property picker's options only react to pointerdown+pointerup (it binds
// listeners on the listbox itself rather than relying on React's delegated
// click, since the menu portals outside the app root — see
// useFieldSelectListboxPointerPick / settings-scope-bar.test.tsx's `tap`).
function tap(target: HTMLElement) {
  fireEvent.pointerDown(target, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(target, { pointerId: 1, clientX: 10, clientY: 10 });
}

async function selectEveryProperty() {
  fireEvent.click(screen.getByRole("button", { name: "Properties" }));
  for (const property of PROPERTY_OPTIONS) {
    const listbox = await screen.findByRole("listbox", { name: "Properties" });
    const option = within(listbox).getByRole("option", { name: property.label });
    // The modal opens scoped to `initialPropertyId` (prop-1), so that option
    // is already ticked — tapping it again would toggle it back off.
    if (option.getAttribute("aria-selected") !== "true") {
      tap(option);
    }
  }
  fireEvent.click(screen.getByRole("button", { name: "Properties" }));
}

function promoField(): HTMLInputElement {
  return screen.getByLabelText(/promo code/i) as HTMLInputElement;
}

describe("promo code with several properties selected", () => {
  it("sends nothing at all, rather than half-writing the selection", async () => {
    renderModal();
    await waitFor(() => expect(promoField()).not.toBeDisabled());
    await selectEveryProperty();

    await waitFor(() => expect(promoField()).toBeDisabled());
    patches.length = 0;
    // Blur is the commit gesture; with no single property it must be inert.
    fireEvent.focus(promoField());
    fireEvent.blur(promoField());
    await act(async () => {
      await Promise.resolve();
    });

    expect(patches).toHaveLength(0);
  });

  it("says the code belongs to one property instead of promising all of them", async () => {
    renderModal();
    await waitFor(() => expect(promoField()).toHaveValue("WELCOME50"));
    await selectEveryProperty();

    expect(await screen.findByText(/a promo code belongs to one property/i)).toBeInTheDocument();
    expect(screen.queryByText(/any of the 3 selected properties/i)).toBeNull();
  });
});

describe("promo code with exactly one property selected", () => {
  it("writes the code for that property and nothing else", async () => {
    renderModal();
    await waitFor(() => expect(promoField()).toHaveValue("WELCOME50"));
    patches.length = 0;

    await userEvent.clear(promoField());
    await userEvent.type(promoField(), "SPRING10");
    fireEvent.blur(promoField());

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ propertyId: "prop-1", waiverCode: "SPRING10" });
    // The waiver write must not smuggle an automation save along with it.
    expect(patches[0]).not.toHaveProperty("automation");
  });
});

describe("automation toggles across several properties", () => {
  it("saves every selected property and never replays the promo code", async () => {
    renderModal();
    await waitFor(() => expect(promoField()).toHaveValue("WELCOME50"));
    await selectEveryProperty();
    patches.length = 0;

    // PortalSettingsToggle is an accessible switch (role="switch"), not a checkbox input.
    await userEvent.click(await screen.findByRole("switch", { name: /auto-approve applications/i }));

    await waitFor(() => expect(patches).toHaveLength(3));
    expect(patches.map((p) => p.propertyId)).toEqual(["prop-1", "prop-2", "prop-3"]);
    for (const patch of patches) {
      expect(patch).toHaveProperty("automation");
      expect(patch).not.toHaveProperty("waiverCode");
    }
  });
});


describe("waiver code save on leaving settings", () => {
  it("flushes a focused edit on Escape without relying on blur", async () => {
    const onClose = vi.fn();
    renderModal(onClose);
    await waitFor(() => expect(promoField()).toHaveValue("WELCOME50"));
    await userEvent.clear(promoField());
    await userEvent.type(promoField(), "ESCAPE10");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(patches).toEqual([{ propertyId: "prop-1", waiverCode: "ESCAPE10" }]);
  });

  it("waits for the waiver request before closing and does not duplicate a blur save", async () => {
    const onClose = vi.fn();
    renderModal(onClose);
    await waitFor(() => expect(promoField()).toHaveValue("WELCOME50"));
    let finish!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => { finish = resolve; });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("manager-application-settings") && init?.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)));
        return response;
      }
      return originalFetch(input, init);
    }));
    await userEvent.clear(promoField());
    await userEvent.type(promoField(), "WAIT10");
    fireEvent.blur(promoField());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      storedCodes.set("prop-1", "WAIT10");
      finish(new Response(JSON.stringify({ waiverCode: "WAIT10" }), { status: 200 }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(patches).toHaveLength(1);
  });

  it("flushes clearing the code and skips an unchanged blur", async () => {
    const onClose = vi.fn();
    renderModal(onClose);
    await waitFor(() => expect(promoField()).toHaveValue("WELCOME50"));
    fireEvent.blur(promoField());
    expect(patches).toHaveLength(0);
    await userEvent.clear(promoField());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(patches).toEqual([{ propertyId: "prop-1", waiverCode: "" }]);
  });

  it("keeps the dialog open and the edit available when the save fails", async () => {
    const onClose = vi.fn();
    renderModal(onClose);
    await waitFor(() => expect(promoField()).toHaveValue("WELCOME50"));
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("manager-application-settings") && init?.method === "PATCH") {
        return new Response(JSON.stringify({ error: "That code is already in use on another property." }), { status: 400 });
      }
      return originalFetch(input, init);
    }));
    await userEvent.clear(promoField());
    await userEvent.type(promoField(), "TAKEN10");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("That code is already in use on another property."));
    expect(onClose).not.toHaveBeenCalled();
    expect(promoField()).toHaveValue("TAKEN10");
    vi.stubGlobal("fetch", originalFetch);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(patches).toEqual([{ propertyId: "prop-1", waiverCode: "TAKEN10" }]);
  });
});


describe("waiver save truth and display", () => {
  it("clears the previous Saved mark as soon as a new edit is pending, then autosaves without blur", async () => {
    renderModal();
    await waitFor(() => expect(promoField()).toHaveValue("WELCOME50"));
    fireEvent.change(promoField(), { target: { value: "FIRST10" } });
    fireEvent.blur(promoField());
    await screen.findByText("Saved");
    fireEvent.change(promoField(), { target: { value: "SECOND10" } });
    expect(screen.queryByText("Saved")).toBeNull();
    await waitFor(() => expect(storedCodes.get("prop-1")).toBe("SECOND10"));
    await screen.findByText("Saved");
  });

  it("displays the normalized code confirmed by a fresh read", async () => {
    renderModal();
    await waitFor(() => expect(promoField()).toHaveValue("WELCOME50"));
    fireEvent.change(promoField(), { target: { value: " spring 10 " } });
    fireEvent.blur(promoField());
    await screen.findByText("Saved");
    expect(promoField()).toHaveValue("SPRING10");
  });

  it("does not claim Saved or close if a 200 write is not reflected by the server read", async () => {
    const onClose = vi.fn();
    renderModal(onClose);
    await waitFor(() => expect(promoField()).toHaveValue("WELCOME50"));
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("manager-application-settings") && init?.method === "PATCH") {
        return new Response(JSON.stringify({ waiverCode: "UNSAVED10" }), { status: 200 });
      }
      return originalFetch(input, init);
    }));
    fireEvent.change(promoField(), { target: { value: "UNSAVED10" } });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Could not confirm the saved waiver code. Please try again."));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText("Saved")).toBeNull();
    expect(promoField()).toHaveValue("UNSAVED10");
  });

  it("ignores an older settings load that finishes after a confirmed save", async () => {
    let finish!: (response: Response) => void;
    const oldRead = new Promise<Response>((resolve) => { finish = resolve; });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("manager-application-settings") && !url.includes("propertyId") && (init?.method ?? "GET") === "GET") return oldRead;
      return originalFetch(input, init);
    }));
    renderModal();
    await waitFor(() => expect(promoField()).toHaveValue("WELCOME50"));
    fireEvent.change(promoField(), { target: { value: "NEWEST10" } });
    fireEvent.blur(promoField());
    await screen.findByText("Saved");
    await act(async () => { finish(new Response(JSON.stringify({ waiverCode: "STALE10" }), { status: 200 })); });
    expect(promoField()).toHaveValue("NEWEST10");
  });
});


it("loads the new property's code even when the previous property's confirmation finishes first", async () => {
  storedCodes.set("prop-2", "FREMONT10");
  const originalFetch = globalThis.fetch;
  let confirmA!: (response: Response) => void;
  let loadB!: (response: Response) => void;
  const readA = new Promise<Response>(resolve => { confirmA = resolve; });
  const readB = new Promise<Response>(resolve => { loadB = resolve; });
  let savingA = false;
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("manager-application-settings")) {
      if (init?.method === "PATCH") savingA = true;
      else if (url.includes("propertyId=prop-1") && savingA) return readA;
      else if (url.includes("propertyId=prop-2")) return readB;
    }
    return originalFetch(input, init);
  }));
  const props = { tab: "applications" as const, propertyOptions: PROPERTY_OPTIONS };
  const view = render(<SettingsModulePage {...props} initialPropertyId="prop-1" />);
  await waitFor(() => expect(promoField()).toHaveValue("WELCOME50"));
  fireEvent.change(promoField(), { target: { value: "BALLARD10" } });
  fireEvent.blur(promoField());
  await waitFor(() => expect(savingA).toBe(true));
  view.rerender(<SettingsModulePage {...props} initialPropertyId="prop-2" />);
  await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringContaining("propertyId=prop-2"), expect.anything()));
  await act(async () => { confirmA(new Response(JSON.stringify({ waiverCode: "BALLARD10" }), { status: 200 })); });
  await act(async () => { loadB(new Response(JSON.stringify({ waiverCode: "FREMONT10" }), { status: 200 })); });
  expect(promoField()).toHaveValue("FREMONT10");
});


it("keeps typing available during a waiver write and confirms the latest edit before Saved", async () => {
  renderModal();
  await waitFor(() => expect(promoField()).toHaveValue("WELCOME50"));
  const originalFetch = globalThis.fetch;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let first = true;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("manager-application-settings") && init?.method === "PATCH" && first) {
      first = false;
      await pending;
    }
    return originalFetch(input, init);
  }));
  fireEvent.change(promoField(), { target: { value: "FIRST10" } });
  fireEvent.blur(promoField());
  await screen.findByText("Saving…");
  expect(promoField()).not.toBeDisabled();
  await userEvent.clear(promoField());
  await userEvent.type(promoField(), "LATEST10");
  await act(async () => { finish(); });
  await screen.findByText("Saved");
  expect(storedCodes.get("prop-1")).toBe("LATEST10");
  expect(promoField()).toHaveValue("LATEST10");
  expect(patches.map(p=>p.waiverCode)).toEqual(["FIRST10", "LATEST10"]);
});
