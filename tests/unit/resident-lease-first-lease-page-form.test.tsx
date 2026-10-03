// @vitest-environment jsdom
/**
 * A lease-first resident opens Lease and sees the lease to sign right there: the lease details
 * form first, then (once signing begins) the published template's signing questions, which
 * hand off to the one signature path. The Lease page reuses `ResidentLeaseFirstSigningWizard`
 * for this — there is no second implementation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  ResidentLeaseFirstSigningWizard,
  leaseFirstSigningPhase,
} from "@/components/portal/resident-lease-first-signing-wizard";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: vi.fn() }),
}));

afterEach(() => cleanup());

function draft(): LeasePipelineRow {
  return {
    id: "lease_first_1",
    residentName: "Jordan Reyes",
    residentEmail: "jreyes@test.com",
    unit: "Room 2",
    status: "Draft",
    bucket: "manager",
    leaseFirst: true,
    leaseIntake: { leaseStart: "2026-11-01", termMonths: 12 },
  } as unknown as LeasePipelineRow;
}

function begun(): LeasePipelineRow {
  return {
    ...draft(),
    status: "Resident Signature Pending",
    bucket: "resident",
    generatedHtml: "<p>Lease body</p>",
    signingTemplateSnapshot: {
      version: 1,
      applicationConfigMode: "custom",
      disabledStandardApplicationKeys: [],
      customApplicationFields: [
        {
          id: "occ-1",
          key: "occupant_count",
          label: "How many people will live in the room?",
          type: "short_text",
          required: true,
          options: [],
          section: "Occupancy",
        },
      ],
    },
  } as unknown as LeasePipelineRow;
}

describe("Lease page for a lease-first draft", () => {
  it("a saved lease-first draft is in the 'not begun' phase and offers Begin signing", () => {
    expect(leaseFirstSigningPhase(draft())).toBe("not-begun");
    render(<ResidentLeaseFirstSigningWizard row={draft()} onReachedSign={vi.fn()} />);
    expect(screen.getByText("Sign your License agreement")).toBeTruthy();
    expect((screen.getByText("Begin signing") as HTMLButtonElement).disabled).toBe(false);
  });

  it("Begin signing waits for the lease details form to be saved", () => {
    const unsaved = { ...draft(), leaseIntake: undefined } as LeasePipelineRow;
    render(<ResidentLeaseFirstSigningWizard row={unsaved} onReachedSign={vi.fn()} />);
    expect((screen.getByText("Begin signing") as HTMLButtonElement).disabled).toBe(true);
  });

  it("once signing has begun, the published template's signing questions render", () => {
    expect(leaseFirstSigningPhase(begun())).toBe("in-progress");
    render(<ResidentLeaseFirstSigningWizard row={begun()} onReachedSign={vi.fn()} />);
    expect(screen.getByText(/How many people will live in the room/)).toBeTruthy();
  });

  it("an application-first lease row never shows the lease-first wizard", () => {
    const ordinary = { ...begun(), leaseFirst: false } as LeasePipelineRow;
    expect(leaseFirstSigningPhase(ordinary)).toBeNull();
    const { container } = render(<ResidentLeaseFirstSigningWizard row={ordinary} onReachedSign={vi.fn()} />);
    expect(container.textContent).toBe("");
  });
});
