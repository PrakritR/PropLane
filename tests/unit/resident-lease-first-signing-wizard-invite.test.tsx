// @vitest-environment jsdom
/**
 * C278 — the Sign step's optional representative / legal representative /
 * guarantor fields render as invite-by-email rows (email input + Send
 * invite), not plain typed-text questions. The resident's own required
 * signature stays outside this wizard (handed off via `onReachedSign`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ResidentLeaseFirstSigningWizard } from "@/components/portal/resident-lease-first-signing-wizard";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";

vi.mock("@/lib/lease-pipeline-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lease-pipeline-storage")>();
  return { ...actual, updateLeasePipelineRow: vi.fn() };
});

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: vi.fn() }),
}));

const originalFetch = global.fetch;
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  global.fetch = originalFetch;
});

function row(): LeasePipelineRow {
  return {
    id: "lease-1",
    residentName: "Jordan Reyes",
    residentEmail: "jreyes@test.com",
    unit: "Room 2",
    status: "Resident Signature Pending",
    bucket: "resident",
    leaseFirst: true,
    generatedHtml: "<p>Lease body</p>",
    signingTemplateSnapshot: {
      version: 1,
      applicationConfigMode: "custom",
      disabledStandardApplicationKeys: [],
      customApplicationFields: [
        {
          id: "f-sig",
          key: "licensee-signature",
          label: "Licensee signature",
          type: "text",
          required: true,
          options: [],
          section: "VII. Agreement authorization",
        },
        {
          id: "f-rep",
          key: "representative",
          label: "Licensee's representative",
          type: "text",
          required: false,
          options: [],
          section: "VII. Agreement authorization",
        },
      ],
    },
  } as unknown as LeasePipelineRow;
}

describe("ResidentLeaseFirstSigningWizard — Sign step invite-by-email", () => {
  it("renders an email input and Send invite button for the optional signer field", () => {
    render(<ResidentLeaseFirstSigningWizard row={row()} onReachedSign={vi.fn()} />);

    // Advance from Review to Sign.
    fireEvent.click(screen.getByText("Continue"));

    expect(screen.getByText("Licensee's representative")).toBeTruthy();
    expect(screen.getByPlaceholderText("email@example.com")).toBeTruthy();
    const sendButton = screen.getByText("Send invite") as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);
    // The required primary signature field never renders as an ordinary input here —
    // it is superseded by the real signing path (`onReachedSign`).
    expect(screen.queryByText("Licensee signature")).toBeNull();
  });

  it("sends the invite and shows Invited once the request succeeds", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }) as unknown as typeof fetch;
    render(<ResidentLeaseFirstSigningWizard row={row()} onReachedSign={vi.fn()} />);
    fireEvent.click(screen.getByText("Continue"));

    fireEvent.change(screen.getByPlaceholderText("email@example.com"), { target: { value: "rep@example.com" } });
    fireEvent.click(screen.getByText("Send invite"));

    await waitFor(() => expect(screen.getByText("Invited")).toBeTruthy());
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/resident/lease-signer-invite",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ leaseId: "lease-1", roleLabel: "Licensee's representative", inviteEmail: "rep@example.com" }),
      }),
    );
  });
});
