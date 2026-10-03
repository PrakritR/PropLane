// @vitest-environment jsdom
//
// Settings -> Workspace -> "Applications & leases" carries only the workspace-wide rows. The
// per-template choices (Lease for an application, Application for a lease, the co-signer links)
// live on each template popup's first step (see template-link-rows.test.tsx).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: vi.fn() }) }));
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));

import { WorkspaceApplicationsLeasesSettings } from "@/components/portal/workspace-applications-leases-settings";

let pipeline: Record<string, unknown>;

beforeEach(() => {
  pipeline = {};
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
  it("renders the four workspace rows with the signing order defaulting to application first", async () => {
    render(<WorkspaceApplicationsLeasesSettings />);
    expect(await screen.findByText("Applications & leases")).toBeTruthy();
    for (const label of ["Signing order", "Roommates in a shared room sign", "Deposit accounting", "Auto-send the lease to the resident"]) {
      expect(screen.getByText(label, { selector: "div, span, p, dt, label" })).toBeTruthy();
    }
    await waitFor(() => expect(screen.getByRole("button", { name: "Signing order" })).toHaveTextContent("Application first, then lease"));
  });

  it("no longer lists per-template mappings or co-signers", async () => {
    render(<WorkspaceApplicationsLeasesSettings />);
    await screen.findByText("Applications & leases");
    for (const title of ["Lease for each application", "Application for each lease", "Co-signers"]) {
      expect(screen.queryByText(title)).toBeNull();
    }
    expect(screen.queryByRole("button", { name: /^(Lease|Application|Co-signer form|Co-signer \/ guarantor addendum) for / })).toBeNull();
  });

  it("saves the signing order once on the workspace record", async () => {
    render(<WorkspaceApplicationsLeasesSettings />);
    await screen.findByText("Applications & leases");
    await pick("Signing order", "Lease first, then application");
    await waitFor(() => expect(pipeline.pipelineOrder).toBe("lease_then_application"));
  });

  it("saves the shared-room default on the workspace record", async () => {
    render(<WorkspaceApplicationsLeasesSettings />);
    await screen.findByText("Applications & leases");
    await pick("Roommates in a shared room sign", "One joint lease for roommates");
    await waitFor(() => expect(pipeline.sharedRoomLease).toBe("joint"));
  });
});
