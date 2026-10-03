// @vitest-environment jsdom
//
// C2-CP8: the property-scoped switches that used to sit on the lease/application editors'
// Settings step live on the Lease tab's settings gear: which leases are offered, month-to-month,
// custom start dates, the property's default lease. Workspace-wide choices are NOT here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PropertyLeaseCatalogSettingsModal } from "@/components/portal/property-lease-catalog-settings-modal";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { createPropertyLeaseTemplate } from "@/lib/property-lease-templates";

const LONG = createPropertyLeaseTemplate({ kind: "long-term", label: "Long-term lease" });
const SHORT = createPropertyLeaseTemplate({ kind: "short-term", label: "Short-term lease" });

/** GET answers a saved pipeline; a PATCH echoes the leasingPipeline it was sent. */
function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { leasingPipeline?: unknown };
        return { ok: true, status: 200, json: async () => ({ leasingPipeline: body.leasingPipeline }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ leasingPipeline: {} }) } as unknown as Response;
    }),
  );
}

beforeEach(() => {
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderModal(over: Partial<React.ComponentProps<typeof PropertyLeaseCatalogSettingsModal>> = {}) {
  const sub = { ...createDefaultListingSubmission(), allowedLeaseTerms: ["12-Month"] };
  const onSaveTemplates = vi.fn().mockResolvedValue(true);
  render(
    <PropertyLeaseCatalogSettingsModal
      open
      onClose={() => {}}
      templates={[LONG, SHORT]}
      propertyId="prop-1"
      onSaveTemplates={onSaveTemplates}
      sub={sub}
      {...over}
    />,
  );
  return { onSaveTemplates };
}

describe("property lease catalog settings modal", () => {
  it("shows the property switches and none of the workspace choices", async () => {
    renderModal();
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
    expect(screen.getByRole("switch", { name: "Offer Long-term lease" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Allow month-to-month" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Allow custom start dates" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Default lease for the property" })).toBeTruthy();
    expect(screen.queryByText("Signing order")).toBeNull();
    expect(screen.queryByText("Who signs first")).toBeNull();
    expect(screen.queryByText("Roommates sign")).toBeNull();
  });

  it("saves the offered leases and the term switches in ONE write", async () => {
    const { onSaveTemplates } = renderModal();
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
    fireEvent.click(screen.getByRole("switch", { name: "Offer Short-term lease" }));
    fireEvent.click(screen.getByRole("switch", { name: "Allow month-to-month" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaveTemplates).toHaveBeenCalledTimes(1));
    const [templates, extra] = onSaveTemplates.mock.calls[0] as [Array<{ id: string; offered?: boolean }>, { allowedLeaseTerms?: string[] }];
    expect(templates.find((t) => t.id === SHORT.id)?.offered).toBe(false);
    expect(extra.allowedLeaseTerms).toEqual(["12-Month", "Month-to-Month"]);
  });

  it("sends no term change when the term switches were not touched, and hides them in a bulk edit", async () => {
    const { onSaveTemplates } = renderModal();
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaveTemplates).toHaveBeenCalled());
    expect(onSaveTemplates.mock.calls[0]?.[1]).toBeUndefined();
    cleanup();
    renderModal({ sub: undefined });
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
    expect(screen.queryByRole("switch", { name: "Allow month-to-month" })).toBeNull();
  });

  it("patches the property's default lease to the lease picked", async () => {
    renderModal();
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Default lease for the property" }));
    const option = await screen.findByText("Short-term lease", { selector: '[role="option"] *, [role="option"]' });
    fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
    await waitFor(() => {
      const patch = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
      expect(patch).toBeTruthy();
      const body = JSON.parse(String((patch![1] as RequestInit).body)) as { leasingPipeline?: { defaultLeaseTemplateId?: string | null } };
      expect(body.leasingPipeline?.defaultLeaseTemplateId).toBe(SHORT.id);
    });
  });
});
