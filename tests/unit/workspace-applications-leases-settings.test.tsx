// @vitest-environment jsdom
//
// Settings -> Workspace -> "Automations" carries only the workspace-wide rows. The
// per-template choices (Lease for an application, Application for a lease, the co-signer links)
// live on each template popup's first step (see template-link-rows.test.tsx).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: vi.fn() }) }));
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));

import { WorkspaceApplicationsLeasesSettings } from "@/components/portal/workspace-applications-leases-settings";

let pipeline: Record<string, unknown>;
let automationBody: Record<string, unknown> | undefined;
let automationStored: Record<string, unknown>;

beforeEach(() => {
  pipeline = {};
  automationBody = undefined;
  automationStored = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("lease-automation-settings")) {
        return { ok: true, status: 200, json: async () => ({ settings: { depositAccountingDays: 21 } }) } as unknown as Response;
      }
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { leasingPipeline?: Record<string, unknown>; automation?: Record<string, unknown> };
        if (body.leasingPipeline) pipeline = body.leasingPipeline;
        if (body.automation) {
          automationBody = body.automation;
          automationStored = body.automation;
        }
        return { ok: true, status: 200, json: async () => ({ leasingPipeline: pipeline, automation: automationStored }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ leasingPipeline: pipeline, automation: automationStored }) } as unknown as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function pick(trigger: string, option: string) {
  const button = screen.getByRole("button", { name: trigger });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  const node = await screen.findByText(option, { selector: '[role="option"] *, [role="option"]' });
  fireEvent.pointerDown(node, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(node, { pointerId: 1, clientX: 10, clientY: 10 });
}

describe("WorkspaceApplicationsLeasesSettings", () => {
  it("renders the workspace rows, with Application before a tour defaulting to Not needed and no Signing order row", async () => {
    render(<WorkspaceApplicationsLeasesSettings />);
    expect(await screen.findByRole("heading", { name: "Applications" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Leases" })).toBeTruthy();
    expect(screen.queryByText("Applications & leases")).toBeNull();
    expect(screen.queryByText("Signing order")).toBeNull();
    for (const label of ["Application before a tour", "Auto-approve applications", "Roommates in a shared room sign", "Deposit accounting", "Auto-send the lease to the resident"]) {
      expect(screen.getByText(label, { selector: "div, span, p, dt, label" })).toBeTruthy();
    }
    await waitFor(() => expect(screen.getByRole("button", { name: "Application before a tour" })).toHaveTextContent("Not needed"));
  });

  it("no longer lists per-template mappings or co-signers", async () => {
    render(<WorkspaceApplicationsLeasesSettings />);
    await screen.findByRole("heading", { name: "Applications" });
    for (const title of ["Lease for each application", "Application for each lease", "Co-signers"]) {
      expect(screen.queryByText(title)).toBeNull();
    }
    expect(screen.queryByRole("button", { name: /^(Lease|Application|Co-signer form|Co-signer \/ guarantor addendum) for / })).toBeNull();
  });

  it("saves Application before a tour once on the workspace record, and the order stays application first", async () => {
    render(<WorkspaceApplicationsLeasesSettings />);
    await screen.findByRole("heading", { name: "Applications" });
    await pick("Application before a tour", "Required");
    await waitFor(() => expect(pipeline.applicationBeforeTour).toBe("required"));
    expect(pipeline.pipelineOrder).toBe("application_then_lease");
  });

  it("saves the shared-room default on the workspace record", async () => {
    render(<WorkspaceApplicationsLeasesSettings />);
    await screen.findByRole("heading", { name: "Applications" });
    await pick("Roommates in a shared room sign", "One joint lease for roommates");
    await waitFor(() => expect(pipeline.sharedRoomLease).toBe("joint"));
  });

  it("puts Application before a tour + Auto-approve under Applications and the other three under Leases", async () => {
    render(<WorkspaceApplicationsLeasesSettings />);
    const apps = (await screen.findByRole("heading", { name: "Applications" })).closest("section")!;
    const leases = screen.getByRole("heading", { name: "Leases" }).closest("section")!;
    expect(apps.textContent).toContain("Application before a tour");
    expect(apps.textContent).toContain("Auto-approve applications");
    expect(leases.textContent).toContain("Roommates in a shared room sign");
    expect(leases.textContent).toContain("Deposit accounting");
    expect(leases.textContent).toContain("Auto-send the lease to the resident");
    expect(leases.textContent).not.toContain("Auto-approve");
  });

  it("Auto-approve applications is Off by default and writes the autoApproveApplications preference", async () => {
    render(<WorkspaceApplicationsLeasesSettings />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Auto-approve applications" })).toHaveTextContent("Off"));
    await pick("Auto-approve applications", "On");
    await waitFor(() => expect(automationBody?.autoApproveApplications).toBe(true));
    expect(automationBody?.autoSendLease).toBe(false);
    await waitFor(() => expect(screen.getByRole("button", { name: "Auto-approve applications" })).toHaveTextContent("On"));
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    await pick("Auto-approve applications", "Off");
    await waitFor(() => expect(automationBody?.autoApproveApplications).toBe(false));
  });
});
