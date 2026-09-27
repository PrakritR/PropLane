// @vitest-environment jsdom
/**
 * C108: the Services list's gear icon opens a real modal — escalation rules
 * read-only, plus a button to the real service-catalog editor — never a
 * link-out disguised as a gear.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

import { ServiceEscalationSettingsModal } from "@/components/portal/service-escalation-settings-modal";

function stubFetch(settings: unknown = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/portal/reminder-settings")) return Response.json({ settings });
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ServiceEscalationSettingsModal", () => {
  it("renders the default escalation rules as read-only rows", async () => {
    stubFetch();
    render(<ServiceEscalationSettingsModal open onClose={() => {}} onEditCatalog={() => {}} />);

    expect(await screen.findByText("Escalate if unassigned")).toBeTruthy();
    expect(screen.getByText("1 day after · notify you")).toBeTruthy();
    expect(screen.getByText("Escalate emergency if unassigned")).toBeTruthy();
    expect(screen.getByText("1 hour after · notify you")).toBeTruthy();
    expect(screen.getByText("Add-on request awaiting decision")).toBeTruthy();
    expect(screen.getByText("2 days after · notify you")).toBeTruthy();
    expect(screen.getByText("Approved but unpaid")).toBeTruthy();
    expect(screen.getByText("3 days after · notify resident")).toBeTruthy();
  });

  it("shows a rule turned off as Off rather than a stale timing", async () => {
    stubFetch({ rules: { work_order_unassigned: { enabled: false } } });
    render(<ServiceEscalationSettingsModal open onClose={() => {}} onEditCatalog={() => {}} />);

    await screen.findByText("Escalate if unassigned");
    expect(screen.getByText("Off")).toBeTruthy();
  });

  it("has no editable timing/audience controls — the real editor lives at Settings -> Notifications", async () => {
    stubFetch();
    render(<ServiceEscalationSettingsModal open onClose={() => {}} onEditCatalog={() => {}} />);

    await screen.findByText("Escalate if unassigned");
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("Edit service catalog calls onEditCatalog, not a raw navigation", async () => {
    stubFetch();
    const onEditCatalog = vi.fn();
    render(<ServiceEscalationSettingsModal open onClose={() => {}} onEditCatalog={onEditCatalog} />);

    fireEvent.click(await screen.findByText("Edit service catalog"));
    expect(onEditCatalog).toHaveBeenCalledTimes(1);
  });
});
