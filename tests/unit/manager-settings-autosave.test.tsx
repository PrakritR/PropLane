/** @vitest-environment jsdom */
/**
 * Applications and Lease settings autosave — a toggle IS the save. This drives
 * the real modal and asserts the PATCH actually happens, because "the switch
 * moved" and "the setting was written" are different facts and the failure mode
 * is silent: the box looks ticked and nothing was stored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast }),
}));
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));
vi.mock("@/hooks/use-manager-user-id", () => ({ useManagerUserId: () => ({ userId: "mgr-1" }) }));
vi.mock("@/hooks/use-work-assignment-directory", () => ({
  useWorkAssignmentDirectory: () => ({ teamMembers: [] }),
}));

import { ManagerPortalSettingsModal } from "@/components/portal/pro-portal-settings-modal";

const PROPERTY_OPTIONS = [{ id: "prop-1", label: "Ballard House" }];

/** Every PATCH body the component sent. */
let patches: Array<Record<string, unknown>>;
/** What GET reports as stored — deliberately NOT updated by PATCH, so a
 *  re-read that clobbers an optimistic toggle is visible as a failure. */
let storedAutomation: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  patches = [];
  storedAutomation = { autoApproveApplications: false };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("manager-application-settings") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({ automation: storedAutomation }), { status: 200 });
      }
      if (url.includes("manager-application-settings") && init?.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ automation: storedAutomation }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Applications settings", () => {
  it("writes the toggle without a Save button", async () => {
    render(
      <ManagerPortalSettingsModal
        open
        onClose={() => undefined}
        initialTab="applications"
        propertyOptions={PROPERTY_OPTIONS}
        initialPropertyId="prop-1"
      />,
    );

    expect(screen.queryByRole("button", { name: /^save$/i })).toBeNull();

    const toggle = await screen.findByRole("checkbox", { name: /auto-approve applications/i });
    await userEvent.click(toggle);

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toMatchObject({
      propertyId: "prop-1",
      automation: expect.objectContaining({ autoApproveApplications: true }),
    });
  });

  it("does not ask for confirmation before turning auto-approve on", async () => {
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmSpy);
    render(
      <ManagerPortalSettingsModal
        open
        onClose={() => undefined}
        initialTab="applications"
        propertyOptions={PROPERTY_OPTIONS}
        initialPropertyId="prop-1"
      />,
    );
    await userEvent.click(await screen.findByRole("checkbox", { name: /auto-approve applications/i }));
    expect(confirmSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(patches).toHaveLength(1));
  });

  it("keeps the toggle on after the write, rather than letting a re-read clobber it", async () => {
    render(
      <ManagerPortalSettingsModal
        open
        onClose={() => undefined}
        initialTab="applications"
        propertyOptions={PROPERTY_OPTIONS}
        initialPropertyId="prop-1"
      />,
    );
    const toggle = await screen.findByRole("checkbox", { name: /auto-approve applications/i });
    await userEvent.click(toggle);
    await waitFor(() => expect(patches).toHaveLength(1));
    // The stub still reports the OLD value on any re-read; the switch must not
    // flip back to it.
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(true));
  });
});
