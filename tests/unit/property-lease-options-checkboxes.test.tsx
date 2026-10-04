// @vitest-environment jsdom
//
// Edit / Add lease: "Allow custom dates" and "Allow month-to-month" replace the Used-for card. They are the
// stored `applicationLeaseTerms` ("Custom", "Month-to-Month") and move the listing's allowed terms, which is
// what the application's "Which lease are you applying for?" offers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearAllWorkspaceDrafts } from "@/components/portal/add-workspace/draft";
import { PropertyLeaseFormModal } from "@/components/portal/property-lease-form-modal";
import { createDefaultListingSubmission, resolveAllowedLeaseTerms } from "@/lib/manager-listing-submission";
import { createPropertyLeaseTemplate, type PropertyLeaseTemplate } from "@/lib/property-lease-templates";
import {
  allowedTermsAfterLeaseOptions,
  deriveLeaseKindFromStayTerms,
  leaseOptionFlags,
  setLeaseOptionOnTemplates,
} from "@/lib/property-form-stay-type-routing";
import { offeredLeaseTermsFromStored } from "@/lib/rental-application/lease-terms";
import { roomFeeTermScope } from "@/lib/room-term-fees";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/portal/property-lease-document-notice", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/components/portal/property-lease-document-notice")>();
  return { ...mod, propertyLeaseNeedsAssistantReview: () => false };
});
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};

const mk = (kind: "long-term" | "short-term", label: string, terms: string[]): PropertyLeaseTemplate => ({
  ...createPropertyLeaseTemplate({ kind, label, source: { kind: "proplane_default" } as never }),
  applicationLeaseTerms: terms,
});

beforeEach(() => {
  clearAllWorkspaceDrafts();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response));
});
afterEach(() => {
  cleanup();
  clearAllWorkspaceDrafts();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const typePicker = () => screen.getByRole("button", { name: /Type of lease/ });
function jumpRail(id: string) {
  const btn = document.querySelector(`[data-attr="listing-v2-rail-${id}"]`) as HTMLElement | null;
  expect(btn).not.toBeNull();
  fireEvent.click(btn!);
}
const box = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;

describe("lease option helpers", () => {
  it("reads the checkbox state from the stored terms", () => {
    expect(leaseOptionFlags(["Long-term"])).toEqual({ custom: false, monthToMonth: false });
    expect(leaseOptionFlags(["Long-term", "Custom", "Month-to-Month"])).toEqual({ custom: true, monthToMonth: true });
  });

  it("a long-term lease with custom dates is still a long-term lease kind", () => {
    expect(deriveLeaseKindFromStayTerms(["Long-term", "Custom"])).toBe("long-term");
    expect(deriveLeaseKindFromStayTerms(["Short-Term Stay"])).toBe("short-term");
  });

  it("toggling stores 'Custom' / 'Month-to-Month' on this lease only and keeps the Long-term base", () => {
    const long = mk("long-term", "Long", ["Long-term"]);
    const other = mk("long-term", "Other", ["Custom"]);
    const next = setLeaseOptionOnTemplates([long, other], long.id, "custom", true);
    expect(next.find((r) => r.id === long.id)?.applicationLeaseTerms).toEqual(["Long-term", "Custom"]);
    expect(next.find((r) => r.id === other.id)?.applicationLeaseTerms).toBeUndefined();
    const off = setLeaseOptionOnTemplates(next, long.id, "custom", false);
    expect(off.find((r) => r.id === long.id)?.applicationLeaseTerms).toEqual(["Long-term"]);
  });

  it("the application still offers custom dates / month-to-month exactly while a lease allows them", () => {
    const sub = createDefaultListingSubmission();
    sub.allowedLeaseTerms = ["Long-term"];
    const long = mk("long-term", "Long", ["Long-term"]);
    const on = setLeaseOptionOnTemplates([long], long.id, "custom", true);
    const allowedOn = allowedTermsAfterLeaseOptions(resolveAllowedLeaseTerms(sub), on, ["custom"]);
    expect(offeredLeaseTermsFromStored(allowedOn)).toEqual(["Long-term", "Custom"]);
    const off = setLeaseOptionOnTemplates(on, long.id, "custom", false);
    expect(allowedTermsAfterLeaseOptions(allowedOn, off, ["custom"])).toEqual(["Long-term"]);
  });

  it("a month-to-month lease still prices from the long-term row", () => {
    expect(roomFeeTermScope("Month-to-Month")).toBe("long");
    expect(roomFeeTermScope("Custom")).toBe("long");
  });
});

describe("Edit lease checkboxes", () => {
  const long = mk("long-term", "Long-term lease", ["Long-term", "Custom"]);
  const short = mk("short-term", "Short term lease", ["Short-Term Stay"]);

  it("shows the stored terms as checked boxes, and no Used for card", async () => {
    const sub = createDefaultListingSubmission();
    sub.allowedLeaseTerms = ["Long-term", "Custom", "Short-Term Stay"];
    render(
      <PropertyLeaseFormModal open mode="edit" sub={sub} template={long} templates={[long, short]}
        propertyId="mgr-house-1" onClose={() => {}} onSave={async () => true} showToast={() => {}} />,
    );
    await screen.findByRole("dialog", { name: "Edit lease" });
    expect(box("Allow custom dates").checked).toBe(true);
    expect(box("Allow month-to-month").checked).toBe(false);
    expect(document.querySelector('[data-attr="property-form-used-for-mapping"]')).toBeNull();
  });

  it("round-trips a toggle into the stored terms and the listing's allowed terms", async () => {
    const sub = createDefaultListingSubmission();
    sub.allowedLeaseTerms = ["Long-term", "Custom", "Short-Term Stay"];
    sub.shortTermRentalsAllowed = true;
    const onSave = vi.fn().mockResolvedValue(true);
    render(
      <PropertyLeaseFormModal open mode="edit" sub={sub} template={long} templates={[long, short]}
        propertyId="mgr-house-1" onClose={() => {}} onSave={onSave} showToast={() => {}} />,
    );
    await screen.findByRole("dialog", { name: "Edit lease" });
    fireEvent.click(box("Allow month-to-month"));
    fireEvent.click(box("Allow custom dates"));
    expect(box("Allow month-to-month").checked).toBe(true);
    expect(box("Allow custom dates").checked).toBe(false);
    jumpRail("document");
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const [saved, extra] = onSave.mock.calls[0]!;
    const row = (saved as PropertyLeaseTemplate[]).find((r) => r.id === long.id)!;
    expect(row.applicationLeaseTerms).toEqual(["Long-term", "Month-to-Month"]);
    expect(row.kind).toBe("long-term");
    expect(extra.allowedLeaseTerms).toEqual(["Long-term", "Month-to-Month", "Short-Term Stay"]);
  });

  it("hides both boxes on a Short-term lease", async () => {
    const sub = createDefaultListingSubmission();
    sub.allowedLeaseTerms = ["Long-term", "Short-Term Stay"];
    render(
      <PropertyLeaseFormModal open mode="edit" sub={sub} template={short} templates={[long, short]}
        propertyId="mgr-house-1" onClose={() => {}} onSave={async () => true} showToast={() => {}} />,
    );
    await screen.findByRole("dialog", { name: "Edit lease" });
    expect(screen.queryByRole("checkbox", { name: "Allow custom dates" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Allow month-to-month" })).toBeNull();
  });
});

describe("Add lease checkboxes", () => {
  const renderAdd = (onSave: (...args: unknown[]) => unknown) => {
    const sub = createDefaultListingSubmission();
    sub.allowedLeaseTerms = ["Long-term"];
    render(
      <PropertyLeaseFormModal open mode="add" sub={sub} templates={[]} propertyId="mgr-house-1"
        onClose={() => {}} onSave={onSave as never} showToast={() => {}} />,
    );
  };

  it("hides the boxes once Short-term is picked", async () => {
    renderAdd(async () => true);
    await screen.findByRole("dialog", { name: "New lease" });
    expect(box("Allow custom dates")).toBeTruthy();
    fireEvent.click(typePicker());
    fireEvent.click(await screen.findByRole("option", { name: "Short-term" }));
    await waitFor(() => expect(screen.queryByRole("checkbox", { name: "Allow custom dates" })).toBeNull());
    expect(screen.queryByRole("checkbox", { name: "Allow month-to-month" })).toBeNull();
  });

  it("saves a ticked option on the new long-term lease", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    renderAdd(onSave);
    await screen.findByRole("dialog", { name: "New lease" });
    fireEvent.change(document.querySelector('[data-attr="property-lease-name"]') as HTMLInputElement, {
      target: { value: "Room lease" },
    });
    fireEvent.click(box("Allow custom dates"));
    jumpRail("document");
    await waitFor(() => expect(screen.getByRole("button", { name: "Create lease" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Create lease" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const [saved, extra] = onSave.mock.calls[0]!;
    expect((saved as PropertyLeaseTemplate[])[0]!.applicationLeaseTerms).toEqual(["Long-term", "Custom"]);
    expect(extra.allowedLeaseTerms).toEqual(["Long-term", "Custom"]);
  });
});
