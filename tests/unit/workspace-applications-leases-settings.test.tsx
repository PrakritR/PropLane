// @vitest-environment jsdom
//
// C2-CP7/8/9: Settings -> Workspace -> "Applications & leases". One signing order for the
// workspace; the workspace-wide choices as label/value rows; and the mapping, which follows the
// order (a Lease dropdown per application, or an Application dropdown per lease) and is written
// through the property record one link at a time.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { createPropertyApplicationTemplate } from "@/lib/property-application-templates";
import { createPropertyLeaseTemplate } from "@/lib/property-lease-templates";

const LONG = createPropertyLeaseTemplate({ kind: "long-term", label: "Long-term lease" });
const SHORT = createPropertyLeaseTemplate({ kind: "short-term", label: "Short-term lease" });
const STANDARD = createPropertyApplicationTemplate({ kind: "long-term", label: "Standard application" });
const QUICK = createPropertyApplicationTemplate({ kind: "long-term", label: "Quick application" });

const persist = vi.fn(async () => true);

vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: vi.fn() }) }));
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", email: "m@example.com", ready: true }),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({
  readExtraListingsForUser: () => [{ id: "prop-1" }],
  readPendingManagerPropertiesForUser: () => [],
  syncPropertyPipelineFromServer: () => Promise.resolve(),
}));
vi.mock("@/lib/manager-property-save-target", () => ({
  resolveManagerListingSubmissionForPropertyId: () => ({
    saveTarget: { mode: "listing", saveId: "prop-1" },
    sub: {
      ...createDefaultListingSubmission(),
      buildingName: "Maple House",
      propertyLeaseTemplates: [LONG, SHORT],
      propertyApplicationTemplates: [STANDARD, QUICK],
      propertyApplicationTemplatesExplicit: true,
    },
  }),
  persistManagerListingSubmissionOnServer: (...args: unknown[]) => persist(...(args as [])),
}));

import { WorkspaceApplicationsLeasesSettings } from "@/components/portal/workspace-applications-leases-settings";

let pipeline: Record<string, unknown>;

beforeEach(() => {
  pipeline = {};
  persist.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("lease-automation-settings")) {
        return { ok: true, status: 200, json: async () => ({ settings: { depositAccountingDays: 21 } }) } as unknown as Response;
      }
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { leasingPipeline?: Record<string, unknown> };
        if (body.leasingPipeline) pipeline = body.leasingPipeline;
        return { ok: true, status: 200, json: async () => ({ leasingPipeline: pipeline }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ leasingPipeline: pipeline, automation: {} }) } as unknown as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function pick(trigger: string, option: string) {
  fireEvent.click(screen.getByRole("button", { name: trigger }));
  const node = await screen.findByText(option, { selector: '[role="option"] *, [role="option"]' });
  fireEvent.pointerDown(node, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(node, { pointerId: 1, clientX: 10, clientY: 10 });
}

describe("WorkspaceApplicationsLeasesSettings", () => {
  it("renders the workspace rows as label/value rows with the signing order defaulting to application first", async () => {
    render(<WorkspaceApplicationsLeasesSettings />);
    expect(await screen.findByText("Applications & leases")).toBeTruthy();
    for (const label of ["Signing order", "Roommates in a shared room sign", "Deposit accounting", "Auto-send the lease to the resident"]) {
      expect(screen.getByText(label, { selector: "div, span, p, dt, label" })).toBeTruthy();
    }
    await waitFor(() => expect(screen.getByRole("button", { name: "Signing order" })).toHaveTextContent("Application first, then lease"));
    expect(screen.getByText("Lease for each application")).toBeTruthy();
    expect(screen.queryByText("Application for each lease")).toBeNull();
  });

  it("application first: one row per application with a single Lease dropdown, saved through the property record", async () => {
    render(<WorkspaceApplicationsLeasesSettings />);
    await screen.findByText("Lease for each application");
    expect(screen.getByRole("button", { name: "Lease for Standard application" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Lease for Quick application" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Application for / })).toBeNull();

    await pick("Lease for Standard application", "Short-term lease");
    await waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    const saved = (persist.mock.calls[0] as unknown as [unknown, string, { propertyApplicationTemplates: Array<{ id: string; linkedLeaseTemplateId?: string | null; usedForLeaseTemplateIds?: string[] }> }])[2];
    const standard = saved.propertyApplicationTemplates.find((t) => t.id === STANDARD.id)!;
    expect(standard.linkedLeaseTemplateId).toBe(SHORT.id);
    expect(standard.usedForLeaseTemplateIds).toEqual([SHORT.id]);
    // Another application is untouched: one lease may serve many applications, never the reverse.
    expect(saved.propertyApplicationTemplates.find((t) => t.id === QUICK.id)!.linkedLeaseTemplateId ?? null).toBeNull();
  });

  it("lease first: switching the signing order saves it once and redraws one row per lease with a single Application dropdown", async () => {
    render(<WorkspaceApplicationsLeasesSettings />);
    await screen.findByText("Lease for each application");
    await pick("Signing order", "Lease first, then application");
    await screen.findByText("Application for each lease");
    expect(pipeline.pipelineOrder).toBe("lease_then_application");
    expect(screen.getByRole("button", { name: "Application for Long-term lease" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Application for Short-term lease" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Lease for / })).toBeNull();

    await pick("Application for Long-term lease", "Quick application");
    await waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    const saved = (persist.mock.calls[0] as unknown as [unknown, string, { propertyLeaseTemplates: Array<{ id: string; linkedApplicationTemplateId?: string | null }> }])[2];
    expect(saved.propertyLeaseTemplates.find((t) => t.id === LONG.id)!.linkedApplicationTemplateId).toBe(QUICK.id);
    expect(saved.propertyLeaseTemplates.find((t) => t.id === SHORT.id)!.linkedApplicationTemplateId ?? null).toBeNull();
  });

  it("saves the shared-room default on the workspace record", async () => {
    render(<WorkspaceApplicationsLeasesSettings />);
    await screen.findByText("Lease for each application");
    await pick("Roommates in a shared room sign", "One joint lease for roommates");
    await waitFor(() => expect(pipeline.sharedRoomLease).toBe("joint"));
  });
});
