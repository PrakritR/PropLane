// @vitest-environment jsdom
/**
 * The lifecycle contract behind two defects found while driving the redrawn settings pages in a
 * real browser:
 *
 *  - Defect 1: a per-control autosave (Tours, Tasks, Communication, every
 *    `ManagerReminderRuleSettingsPanel`) saved internally without ever reporting through the
 *    host's `onSaveStatusChange` channel — the `SaveStatus` mark stayed dead (`idle` forever)
 *    even though the write actually landed.
 *  - Defect 2: that per-control save is debounced 600ms, and nothing flushed the pending write
 *    when the manager left before the timer fired — a tab switch the host didn't explicitly
 *    flush, or an unmount for any other reason.
 *
 * `CommunicationSettingsPanel` stands in for the shared report/flush/unmount shape every one of
 * those panels now uses (`useReportSettingsSaveStatus`, `useFlushSettingsAutosaveOnUnmount`) —
 * it has the smallest fetch surface of the four, so it is the cleanest place to prove the
 * LIFECYCLE contract without re-testing each panel's own fields (already covered by
 * `settings-module-redraws.test.tsx`, `tour-settings-redraw.test.tsx`, etc). Switching
 * Profile panes unmounts `SettingsModulePage`, which is the same flush-on-unmount path
 * the last test here covers. The gear modal's flush-before-close is
 * `portal-settings-save-flush.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast }),
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  // Spread the real module: this file only needs to override demo mode, and a hand-listed mock
  // silently breaks every time the module gains an export a component calls at import time.
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));
vi.mock("@/hooks/use-manager-user-id", () => ({ useManagerUserId: () => ({ userId: "mgr-1" }) }));
vi.mock("@/hooks/use-work-assignment-directory", () => ({
  useWorkAssignmentDirectory: () => ({ teamMembers: [] }),
}));

import {
  SettingsModulePage,
  type SettingsModulePageHandle,
  type SettingsModuleSaveStatus,
} from "@/components/portal/settings-module-page";
import { DEFAULT_MANAGER_AUTOMATION_SETTINGS } from "@/lib/payment-automation-settings";

/** Every PATCH body any stubbed endpoint below received, tagged by which one. */
let patches: Array<{ url: string; body: Record<string, unknown> }>;

function stubCommunicationFetch(options?: { failPatch?: boolean }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/api/manager/messaging-number")) return new Response("missing", { status: 404 });
      if (url.includes("/api/portal/automation-settings")) {
        if (method === "PATCH") {
          patches.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
          if (options?.failPatch) {
            return new Response(JSON.stringify({ error: "Could not save communication settings." }), {
              status: 500,
            });
          }
        }
        return Response.json({ settings: DEFAULT_MANAGER_AUTOMATION_SETTINGS });
      }
      throw new Error(`Unexpected fetch: ${url} (${method})`);
    }),
  );
}

beforeEach(() => {
  patches = [];
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  showToast.mockClear();
});

async function renderCommunication(onSaveStatusChange: (status: SettingsModuleSaveStatus) => void) {
  const ref = createRef<SettingsModulePageHandle>();
  render(<SettingsModulePage ref={ref} tab="communication" onSaveStatusChange={onSaveStatusChange} />);
  const toggle = await screen.findByRole("switch", { name: "Auto-send AI drafts" });
  return { ref, toggle };
}

describe("per-control autosave reports through the host's save status (Defect 1)", () => {
  it("drives saving then saved for a real edit — the host actually receives BOTH transitions, not just a PATCH", async () => {
    stubCommunicationFetch();
    const statuses: SettingsModuleSaveStatus[] = [];
    const { toggle } = await renderCommunication((s) => statuses.push(s));

    fireEvent.click(toggle);

    await waitFor(() => expect(patches).toHaveLength(1), { timeout: 3000 });
    await waitFor(() => expect(statuses.at(-1)?.state).toBe("saved"), { timeout: 3000 });

    const savingIndex = statuses.findIndex((s) => s.state === "saving");
    const savedIndex = statuses.findIndex((s) => s.state === "saved");
    expect(savingIndex, "the host must see 'saving' at some point").toBeGreaterThanOrEqual(0);
    expect(savedIndex, "'saved' must come after 'saving', not stand alone").toBeGreaterThan(savingIndex);
  });

  it("a failing autosave drives the status to error and surfaces the reason", async () => {
    stubCommunicationFetch({ failPatch: true });
    const statuses: SettingsModuleSaveStatus[] = [];
    const { toggle } = await renderCommunication((s) => statuses.push(s));

    fireEvent.click(toggle);

    await waitFor(() => expect(patches).toHaveLength(1), { timeout: 3000 });
    await waitFor(() => expect(statuses.at(-1)?.state).toBe("error"), { timeout: 3000 });

    expect(statuses.at(-1)?.reason).toBe("Could not save communication settings.");
    // Unconditional — the same failure must still toast, exactly like the dialog's own flush.
    expect(showToast).toHaveBeenCalledWith("Could not save communication settings.");
  });
});

describe("a pending debounced save is never lost when the manager leaves first (Defect 2)", () => {
  it("unmounting flushes a pending debounced save", async () => {
    stubCommunicationFetch();
    const { toggle } = await renderCommunication(() => {});

    fireEvent.click(toggle);
    // The debounce window (600ms) has not elapsed — nothing has been sent yet.
    expect(patches).toHaveLength(0);

    cleanup();

    await waitFor(() => expect(patches).toHaveLength(1), { timeout: 3000 });
    expect(patches[0]!.body).toMatchObject({ inboxAiDraftAutoSend: true });
  });

  it("a pending save is not silently dropped when the debounce timer has not yet elapsed", async () => {
    stubCommunicationFetch();
    const { ref, toggle } = await renderCommunication(() => {});

    fireEvent.click(toggle);
    expect(patches).toHaveLength(0);

    // Flush RIGHT NOW, well inside the 600ms window — `isDirty` is already true synchronously
    // from the toggle, independent of whether the debounce timer itself has fired.
    const result = await ref.current!.flushPendingSaves();

    expect(result).toEqual({ ok: true });
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toMatchObject({ inboxAiDraftAutoSend: true });
  });
});
