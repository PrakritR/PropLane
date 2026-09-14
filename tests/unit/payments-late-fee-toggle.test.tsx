// @vitest-environment jsdom
/**
 * Regression for the Payments "Late fee notices" toggle that saved nothing:
 * `PaymentAutomationSettingsForm` had no per-control autosave at all (unlike
 * every sibling settings panel — see `settings-save-status-context.ts`'s own
 * doc list), so on `/portal/settings/payments` (autosave, no Save button)
 * flipping the switch updated local state and reached no save path.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_MANAGER_AUTOMATION_SETTINGS, type ManagerAutomationSettings } from "@/lib/payment-automation-settings";

const showToast = vi.fn();

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => (req: { description?: unknown }) =>
    Promise.resolve(
      typeof window === "undefined"
        ? true
        : window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
    ),
  useAppUi: () => ({ showToast }),
}));

import { PaymentAutomationSettingsPanel } from "@/components/portal/payment-schedule-ui";

function stubFetch(onPatch: (body: unknown) => ManagerAutomationSettings) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/portal/automation-settings")) {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        return Response.json({ settings: onPatch(body) });
      }
      return Response.json({ settings: DEFAULT_MANAGER_AUTOMATION_SETTINGS });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  showToast.mockClear();
});

describe("Payments late fee notices toggle", () => {
  it("reaches the save path — a PATCH fires, not just a state change", async () => {
    const fetchMock = stubFetch((body) => ({
      ...DEFAULT_MANAGER_AUTOMATION_SETTINGS,
      ...(body as Partial<ManagerAutomationSettings>),
    }));

    render(
      <PaymentAutomationSettingsPanel
        settings={{ ...DEFAULT_MANAGER_AUTOMATION_SETTINGS, lateFeeNoticeEnabled: false }}
        variant="payments"
        layout="modal"
        autoSaveOnClose
        onSaved={() => {}}
      />,
    );

    const toggle = await screen.findByRole("switch", { name: "Late fee notices" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    await userEvent.click(toggle);

    // The toggle alone must not be enough — assert the persist function (fetch PATCH)
    // was actually invoked, not merely that the switch's own visual state flipped.
    await waitFor(
      () => {
        const patchCalls = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
        expect(patchCalls.length).toBeGreaterThan(0);
      },
      { timeout: 2000 },
    );

    const [, init] = fetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === "PATCH")!;
    const sentBody = JSON.parse(String((init as RequestInit).body));
    expect(sentBody.lateFeeNoticeEnabled).toBe(true);
  });

  it("round-trips: toggle, save, and a fresh load from the saved value still shows it on", async () => {
    let saved: ManagerAutomationSettings = { ...DEFAULT_MANAGER_AUTOMATION_SETTINGS, lateFeeNoticeEnabled: false };
    stubFetch((body) => {
      saved = { ...saved, ...(body as Partial<ManagerAutomationSettings>) };
      return saved;
    });

    const { unmount } = render(
      <PaymentAutomationSettingsPanel
        settings={saved}
        variant="payments"
        layout="modal"
        autoSaveOnClose
        onSaved={() => {}}
      />,
    );

    const toggle = await screen.findByRole("switch", { name: "Late fee notices" });
    await userEvent.click(toggle);

    await waitFor(() => expect(saved.lateFeeNoticeEnabled).toBe(true), { timeout: 2000 });

    unmount();

    // Simulate a reload: mount a fresh instance seeded from what the server now holds.
    render(
      <PaymentAutomationSettingsPanel
        settings={saved}
        variant="payments"
        layout="modal"
        autoSaveOnClose
        onSaved={() => {}}
      />,
    );

    const toggleAfterReload = await screen.findByRole("switch", { name: "Late fee notices" });
    expect(toggleAfterReload.getAttribute("aria-checked")).toBe("true");
  });

  it("no longer draws lateFeeNoticeEnabled with a raw checkbox input", () => {
    const src = readFileSync(`${process.cwd()}/src/components/portal/payment-schedule-ui.tsx`, "utf8");
    const lines = src.split("\n").filter((line) => line.includes("lateFeeNoticeEnabled"));
    for (const line of lines) {
      expect(line).not.toContain('type="checkbox"');
    }
  });
});
