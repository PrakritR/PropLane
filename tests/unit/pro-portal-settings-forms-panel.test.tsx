// @vitest-environment jsdom
//
// Settings → Forms (C110/C113/C231): the new nav entry's panel. This suite
// stubs the network and the heavy embedded property-scoped editors (already
// covered by their own suites) and checks the composition: naming controls,
// the three application variants with a real "Used at" count, and the lease
// clause editor with a working {variable} chip + live preview.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", email: "manager@example.com", ready: true }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: vi.fn() }),
}));
vi.mock("@/components/portal/pro-edit-application-modal", () => ({
  ManagerPropertyApplicationFormEditor: () => <div data-testid="pane-import-application" />,
}));
vi.mock("@/components/portal/pro-edit-leases-modal", () => ({
  ManagerPropertyLeaseFormEditor: () => <div data-testid="pane-import-lease" />,
}));
vi.mock("@/lib/manager-property-save-target", () => ({
  resolveManagerListingSubmissionForPropertyId: (managerUserId: string | null, propertyId: string) =>
    propertyId === "prop_custom" ? { sub: { applicationFormSource: "custom" } } : { sub: {} },
}));

import { ManagerFormsSettingsPanel } from "@/components/portal/pro-portal-settings-forms-panel";

const PROPERTY_OPTIONS = [
  { id: "prop_alder", label: "Alder House" },
  { id: "prop_custom", label: "Custom Corner" },
];

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("Settings → Forms panel", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        // A PATCH echoes back whatever the caller just sent, like the real
        // routes do — a GET-only stub would silently revert every optimistic
        // edit the moment its save promise resolved.
        if (init?.method === "PATCH" && typeof init.body === "string") {
          const body = JSON.parse(init.body) as Record<string, unknown>;
          if ("terminology" in body) return jsonResponse({ terminology: body.terminology });
          if ("template" in body) return jsonResponse({ template: body.template });
        }
        if (url.includes("/api/portal/forms-terminology")) {
          return jsonResponse({ terminology: { applicationLabel: null, leaseLabel: null } });
        }
        if (url.includes("/api/portal/application-form")) {
          return jsonResponse({
            template: {
              customApplicationFields: [],
              disabledStandardApplicationKeys: [],
              applicationConfigMode: "standard",
              shortTermCustomApplicationFields: [],
              shortTermDisabledStandardApplicationKeys: [],
              shortTermApplicationConfigMode: "standard",
              cosignerCustomApplicationFields: [],
              cosignerDisabledStandardApplicationKeys: [],
              cosignerApplicationConfigMode: "standard",
              shareAcrossVariants: true,
            },
          });
        }
        if (url.includes("/api/portal/lease-clause-template")) {
          return jsonResponse({ template: { clauses: [] } });
        }
        return jsonResponse({});
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders naming, the application variants, used-at, and the lease clause editor", async () => {
    render(<ManagerFormsSettingsPanel propertyOptions={PROPERTY_OPTIONS} />);

    expect(await screen.findByText("Application")).toBeTruthy();
    expect(screen.getByText("Lease")).toBeTruthy();
    expect(document.querySelector('[data-attr="forms-term-application"]')).toBeTruthy();
    expect(document.querySelector('[data-attr="forms-term-lease"]')).toBeTruthy();

    // One of two properties follows the workspace form (the other opted into "custom").
    await waitFor(() => expect(screen.getByText("1 of 2 properties")).toBeTruthy());

    // Variant tabs.
    expect(document.querySelector('[data-attr="forms-application-tab-main"]')).toBeTruthy();
    expect(document.querySelector('[data-attr="forms-application-tab-shortTerm"]')).toBeTruthy();
    expect(document.querySelector('[data-attr="forms-application-tab-cosigner"]')).toBeTruthy();

    // Add a lease clause, insert a variable chip, and see the live sample preview.
    fireEvent.click(screen.getByText("Add clause"));
    const titleInput = await screen.findByPlaceholderText("Clause title");
    expect(titleInput).toBeTruthy();
    const rentChip = document.querySelector('[data-attr="forms-lease-clause-variable-rentAmount"]')!;
    fireEvent.click(rentChip);
    await waitFor(() => expect(screen.getByText(/\$2,150\.00/)).toBeTruthy());
  });

  it("saves a naming change on blur", async () => {
    render(<ManagerFormsSettingsPanel propertyOptions={PROPERTY_OPTIONS} />);
    await screen.findByText("Application");

    const input = document.querySelector('[data-attr="forms-term-application"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Intake form" } });
    fireEvent.blur(input);

    await waitFor(() => {
      const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some(([url, init]: [string, RequestInit]) => String(url).includes("forms-terminology") && init?.method === "PATCH")).toBe(true);
    });
    expect(await screen.findByText("Intake form")).toBeTruthy();
  });
});
