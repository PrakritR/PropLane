// @vitest-environment jsdom
//
// "Edits must save" for the property tabs (captain, Oct 4 2026): the Applications tab's editor, the Lease tab's
// editor and the Move-in tab's editor each hold their edits in local state until Save. Each test edits through
// the real modal, takes exactly what the modal hands to its save path, sends that down the real persistence
// chain (the pre-save normalize, JSON, the server's version-preserving merge, the read-time normalize) and
// re-opens the editor from the stored copy.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
const persistOnServer = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<boolean>>());
vi.mock("@/lib/manager-property-save-target", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-property-save-target")>()),
  persistManagerListingSubmissionOnServer: (...args: unknown[]) => persistOnServer(...args),
}));
vi.mock("@/lib/listing-submission-media-upload", () => ({
  uploadListingSubmissionMedia: vi.fn(async (submission: unknown) => ({ submission, failedCount: 0 })),
}));
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};

import { ManagerApplicationQuestionsEditorModal } from "@/components/portal/pro-application-questions-editor-modal";
import { PropertyLeaseFormModal } from "@/components/portal/property-lease-form-modal";
import { clearAllWorkspaceDrafts } from "@/components/portal/add-workspace/draft";
import { PropertyRoomPricingWorkspace } from "@/components/portal/property-room-pricing-workspace";
import { createDefaultListingSubmission, emptyRoom, normalizeManagerListingSubmissionV1, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { prepareListingSubmissionForPersist } from "@/lib/prepare-listing-submission-for-persist";
import { preserveServerOwnedApplicationVersions } from "@/lib/rental-application/server-owned-template-versions";
import {
  applicationTemplateQuestionConfigFromSlice,
  readPropertyApplicationTemplates,
  withPropertyApplicationTemplatesExplicit,
  type PropertyApplicationTemplate,
} from "@/lib/property-application-templates";
import { readPropertyLeaseTemplates, syncLegacyLeaseFieldsFromTemplates, type PropertyLeaseTemplate } from "@/lib/property-lease-templates";
import { MOVE_IN_FORM_STARTERS, moveInFormLeaseTypePatch, moveInFormLeaseTypeValue, readMoveInFormTemplates } from "@/lib/move-in-forms/templates";
import { cleanMoveInTemplateForSave, upsertMoveInTemplate } from "@/components/portal/move-in-forms/move-in-form-model";

async function stored(next: ManagerListingSubmissionV1, previous?: ManagerListingSubmissionV1): Promise<ManagerListingSubmissionV1> {
  const { submission } = await prepareListingSubmissionForPersist(next, { validateWaiverCode: false });
  const wire = JSON.parse(JSON.stringify(submission));
  const merged = preserveServerOwnedApplicationVersions(
    { listingSubmission: wire },
    previous ? { listingSubmission: JSON.parse(JSON.stringify(previous)) } : undefined,
  ) as { listingSubmission: ManagerListingSubmissionV1 };
  return normalizeManagerListingSubmissionV1(JSON.parse(JSON.stringify(merged.listingSubmission)));
}

const iso = "2026-10-01T00:00:00Z";
function leaseRow(id: string, label: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    kind: "long-term",
    label,
    leaseConfigMode: "standard",
    leaseCustomKind: "terms",
    customLeaseTerms: "",
    leaseTemplateDocUrl: null,
    leaseTemplateDocName: "",
    createdAt: iso,
    updatedAt: iso,
    ...extra,
  };
}

function subWithForms(): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  const petQuestion = { id: "c-pet", key: "pet-name", label: "Pet name", type: "text", required: false, options: [], section: "additional" };
  const draft = applicationTemplateQuestionConfigFromSlice({
    applicationConfigMode: "custom",
    disabledStandardApplicationKeys: [],
    customApplicationFields: [petQuestion],
  } as never);
  return {
    ...base,
    address: "400 Pike Street",
    shortTermRentalsAllowed: true,
    allowedLeaseTerms: ["Long-term", "Short-Term Stay"],
    propertyLeaseTemplates: [
      leaseRow("l-long", "Long-term lease", { listingSeedKey: "primary", applicationLeaseTerms: ["Long-term"] }),
      leaseRow("l-short", "Short-term lease", { kind: "short-term", listingSeedKey: "short-term", applicationLeaseTerms: ["Short-Term Stay"] }),
    ],
    propertyApplicationTemplates: [
      { id: "a-long", kind: "long-term", formVariant: "standard", label: "Long-term application", draftQuestionConfig: draft, createdAt: iso, updatedAt: iso },
      { id: "a-short", kind: "short-term", formVariant: "short_term", label: "Short-term application", createdAt: iso, updatedAt: iso },
      { id: "a-cos", kind: "long-term", formVariant: "cosigner", label: "Co-signer application", createdAt: iso, updatedAt: iso },
    ],
    propertyApplicationTemplatesExplicit: true,
  } as unknown as ManagerListingSubmissionV1;
}

const q = (selector: string) => document.querySelector(selector) as HTMLElement | null;
const jumpRail = (id: string) => {
  const btn = q(`[data-attr="listing-v2-rail-${id}"]`);
  expect(btn, `rail ${id}`).not.toBeNull();
  fireEvent.click(btn!);
};
function tapOption(label: string) {
  const listbox = screen.getAllByRole("listbox").at(-1)!;
  const option = Array.from(listbox.querySelectorAll('[role="option"]')).find((node) => node.textContent?.includes(label));
  expect(option, `option ${label}`).toBeTruthy();
  fireEvent.pointerDown(option!, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(option!, { pointerId: 1, clientX: 10, clientY: 10 });
}
const pick = (attr: string, label: string) => {
  fireEvent.click(q(`[data-attr="${attr}"]`)!);
  tapOption(label);
};

beforeEach(() => {
  persistOnServer.mockReset();
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
  clearAllWorkspaceDrafts();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ template: {} }), { status: 200, headers: { "content-type": "application/json" } })),
  );
});
afterEach(() => {
  cleanup();
  clearAllWorkspaceDrafts();
  vi.unstubAllGlobals();
});

function renderApplicationEditor(sub: ManagerListingSubmissionV1, templateId: string, persist: (merged: ManagerListingSubmissionV1) => Promise<boolean>) {
  const templates = readPropertyApplicationTemplates(sub);
  render(
    <ManagerApplicationQuestionsEditorModal
      open
      title="Edit application"
      sub={sub}
      managerUserId="manager-1"
      applicationPreviewPropertyId="mgr-house-1"
      templateEditorMode="edit"
      applicationTemplate={templates.find((row) => row.id === templateId)!}
      templates={templates}
      signingOrder="application_then_lease"
      onPersistSubmission={persist as never}
      onClose={() => {}}
      onSaved={() => {}}
      showToast={() => {}}
    />,
  );
}

const waitDialog = (name: string) => screen.findByRole("dialog", { name });
const applicationOf = (sub: ManagerListingSubmissionV1, id: string) => readPropertyApplicationTemplates(sub).find((row) => row.id === id)!;

async function saveApplication() {
  jumpRail("sections");
  await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

describe("property Applications tab: the application editor stores every edit", () => {
  it("name, fee, applies to, defaults, lease, co-signer form and a question's label, type, required and linked form all survive Save", async () => {
    const original = subWithForms();
    const persist = vi.fn().mockResolvedValue(true);
    renderApplicationEditor(original, "a-long", persist);
    await waitDialog("Edit application");

    fireEvent.change(q('[data-attr="property-application-name"]')!, { target: { value: "Renamed long application" } });
    const fee = screen.getByLabelText("Application fee") as HTMLInputElement;
    fireEvent.focus(fee);
    fireEvent.change(fee, { target: { value: "60" } });
    pick("application-applies-to", "Both");
    // Both stays: a default switch for each.
    // A switch that shows on only because the form is its section's first is flipped off and on again, so the
    // choice is the manager's own and is stored.
    for (const stay of ["long-term", "short-term"]) {
      const toggle = () => q(`[data-attr="application-default-for-${stay}"]`)!;
      if (toggle().getAttribute("aria-checked") === "true") fireEvent.click(toggle());
      fireEvent.click(toggle());
      expect(toggle().getAttribute("aria-checked")).toBe("true");
    }
    pick("application-lease-link", "Short-term lease");
    pick("application-cosigner-form-link", "Co-signer application");

    // A question: label, type and required, then a linked form rule.
    jumpRail("sections");
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
    const prefix = "application-questions-editor";
    const section = q(`[data-attr="${prefix}-section-toggle-additional"]`)!;
    if (section.getAttribute("aria-expanded") !== "true") fireEvent.click(section);
    const petRow = Array.from(document.querySelectorAll<HTMLElement>("[data-question-id]")).find((el) => el.textContent?.includes("Pet name"))!;
    fireEvent.click(petRow.querySelector(`[data-attr="${prefix}-question-open"]`)!);
    fireEvent.change(q(`[data-attr="${prefix}-question-label"]`)!, { target: { value: "Pet name or breed" } });
    pick(`${prefix}-question-type`, "Long text");
    fireEvent.click(q(`[data-attr="${prefix}-question-required"]`)!);
    fireEvent.click(screen.getByRole("button", { name: "+ Link a form" }));
    fireEvent.click(q(`[data-attr="${prefix}-question-done"]`)!);

    await saveApplication();
    await waitFor(() => expect(persist).toHaveBeenCalled());
    const handed = persist.mock.calls.at(-1)![0] as ManagerListingSubmissionV1;
    const reread = await stored(handed, original);

    const row = applicationOf(reread, "a-long");
    expect(row.label).toBe("Renamed long application");
    expect(row.feeCentsOverride).toBe(6000);
    expect(row.appliesTo).toBe("both");
    expect([...(row.defaultFor ?? [])].sort()).toEqual(["long_term", "short_term"]);
    expect(row.linkedLeaseTemplateId).toBe("l-short");
    expect(row.linkedCosignerApplicationTemplateId).toBe("a-cos");
    const pet = (row.draftQuestionConfig?.customApplicationFields ?? []).find((field) => field.id === "c-pet");
    expect(pet?.label).toBe("Pet name or breed");
    expect(pet?.type).toBe("long_text");
    expect(pet?.required).toBe(true);
    expect(pet?.linkedForms?.length).toBe(1);

    // The tab reloads from the stored copy and the editor shows the same values.
    cleanup();
    renderApplicationEditor(reread, "a-long", vi.fn().mockResolvedValue(true));
    await waitDialog("Edit application");
    expect((q('[data-attr="property-application-name"]') as HTMLInputElement).value).toBe("Renamed long application");
    expect((screen.getByLabelText("Application fee") as HTMLInputElement).value).toBe("60");
    expect(q('[data-attr="application-applies-to"]')!.textContent).toContain("Both");
    expect(q('[data-attr="application-lease-link"]')!.textContent).toContain("Short-term lease");
    expect(q('[data-attr="application-cosigner-form-link"]')!.textContent).toContain("Co-signer application");
  });

  it("a short-term application has no co-signer field and saves with no co-signer link", async () => {
    const original = subWithForms();
    // A link stored before co-signer became long term only.
    original.propertyApplicationTemplates = (original.propertyApplicationTemplates as unknown as Array<Record<string, unknown>>).map((row) =>
      row.id === "a-short" ? { ...row, linkedCosignerApplicationTemplateId: "a-cos" } : row,
    ) as unknown as PropertyApplicationTemplate[];
    const persist = vi.fn().mockResolvedValue(true);
    renderApplicationEditor(original, "a-short", persist);
    await waitDialog("Edit application");
    expect(q('[data-attr="application-cosigner-form-link"]')).toBeNull();
    fireEvent.change(q('[data-attr="property-application-name"]')!, { target: { value: "Short stays" } });
    await saveApplication();
    await waitFor(() => expect(persist).toHaveBeenCalled());
    const reread = await stored(persist.mock.calls.at(-1)![0] as ManagerListingSubmissionV1, original);
    const row = applicationOf(reread, "a-short");
    expect(row.label).toBe("Short stays");
    expect(row.linkedCosignerApplicationTemplateId ?? null).toBeNull();
  });

  it("moving a form to short term in the editor hides its co-signer field and clears the stored link", async () => {
    const original = subWithForms();
    original.propertyApplicationTemplates = (original.propertyApplicationTemplates as unknown as Array<Record<string, unknown>>).map((row) =>
      row.id === "a-long" ? { ...row, linkedCosignerApplicationTemplateId: "a-cos" } : row,
    ) as unknown as PropertyApplicationTemplate[];
    const persist = vi.fn().mockResolvedValue(true);
    renderApplicationEditor(original, "a-long", persist);
    await waitDialog("Edit application");
    expect(q('[data-attr="application-cosigner-form-link"]')).not.toBeNull();
    pick("application-applies-to", "Short-term residents");
    expect(q('[data-attr="application-cosigner-form-link"]')).toBeNull();
    await saveApplication();
    await waitFor(() => expect(persist).toHaveBeenCalled());
    const reread = await stored(persist.mock.calls.at(-1)![0] as ManagerListingSubmissionV1, original);
    const row = applicationOf(reread, "a-long");
    expect(row.appliesTo).toBe("short_term");
    expect(row.linkedCosignerApplicationTemplateId ?? null).toBeNull();
  });

  it("the co-signer form's editor has no Applies to or default rows (it is long term only)", async () => {
    renderApplicationEditor(subWithForms(), "a-cos", vi.fn().mockResolvedValue(true));
    await waitDialog("Edit application");
    expect(q('[data-attr="application-applies-to"]')).toBeNull();
    expect(q('[data-attr="application-default-for-long-term"]')).toBeNull();
    expect(q('[data-attr="application-cosigner-form-link"]')).toBeNull();
  });

  it("the first card leads with Application name, then Applies to and the default switch", async () => {
    renderApplicationEditor(subWithForms(), "a-long", vi.fn().mockResolvedValue(true));
    await waitDialog("Edit application");
    const card = q('[data-attr="property-application-step-one-card"]')!;
    const text = card.textContent ?? "";
    expect(text.indexOf("Application name")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Application name")).toBeLessThan(text.indexOf("Applies to"));
    expect(text.indexOf("Applies to")).toBeLessThan(text.indexOf("Default for long term"));
    expect(text.indexOf("Default for long term")).toBeLessThan(text.indexOf("Lease"));
    expect(text.indexOf("Lease")).toBeLessThan(text.indexOf("Co-signer form"));
    expect(text).not.toContain("Default for its section");
    // The fee follows in the next card.
    expect(q('[data-attr="property-application-fee-card"]')!.textContent).toContain("Application fee");
  });
});

describe("property Lease tab: the lease editor stores every edit", () => {
  const sync = (sub: ManagerListingSubmissionV1, templates: PropertyLeaseTemplate[], extra?: { allowedLeaseTerms?: string[]; applications?: PropertyApplicationTemplate[] }) => {
    // What the Lease tab does with the modal's onSave arguments before it persists.
    const withLeases = { ...syncLegacyLeaseFieldsFromTemplates(sub, templates), ...(extra?.allowedLeaseTerms ? { allowedLeaseTerms: extra.allowedLeaseTerms } : {}) };
    return extra?.applications ? withPropertyApplicationTemplatesExplicit(withLeases, extra.applications) : withLeases;
  };

  it("name, fee and the month-to-month option survive Save and a re-read", async () => {
    const original = subWithForms();
    const leases = readPropertyLeaseTemplates(original);
    const onSave = vi.fn().mockResolvedValue(true);
    const open = (sub: ManagerListingSubmissionV1, templateId: string, handler: typeof onSave) => {
      const all = readPropertyLeaseTemplates(sub);
      render(
        <PropertyLeaseFormModal
          open
          mode="edit"
          sub={sub}
          template={all.find((row) => row.id === templateId)!}
          templates={all}
          propertyId="mgr-house-1"
          onClose={() => {}}
          onSave={handler as never}
          showToast={() => {}}
        />,
      );
    };
    open(original, "l-long", onSave);
    await screen.findByRole("dialog", { name: "Edit lease" });
    const name = q('[data-attr="property-lease-name"]') as HTMLInputElement | null;
    expect(name, "the lease name field").not.toBeNull();
    fireEvent.change(name!, { target: { value: "Long stay lease" } });
    const fee = screen.getByLabelText(/Lease fee/i) as HTMLInputElement;
    fireEvent.focus(fee);
    fireEvent.change(fee, { target: { value: "300" } });
    const m2m = screen.getByRole("checkbox", { name: /month-to-month/i }) as HTMLInputElement;
    fireEvent.click(m2m);
    jumpRail("document");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const [nextTemplates, extra] = onSave.mock.calls.at(-1)! as [PropertyLeaseTemplate[], { allowedLeaseTerms?: string[]; applications?: PropertyApplicationTemplate[] }];
    const reread = await stored(sync(original, nextTemplates, extra), original);
    const lease = readPropertyLeaseTemplates(reread).find((row) => row.id === "l-long")!;
    expect(lease.label).toBe("Long stay lease");
    expect(lease.leaseFeeCents).toBe(30000);
    expect(lease.applicationLeaseTerms).toContain("Month-to-Month");
    expect(reread.allowedLeaseTerms).toContain("Month-to-Month");
    expect(leases.length).toBe(readPropertyLeaseTemplates(reread).length);

    cleanup();
    open(reread, "l-long", vi.fn().mockResolvedValue(true));
    await screen.findByRole("dialog", { name: "Edit lease" });
    jumpRail("name");
    expect((q('[data-attr="property-lease-name"]') as HTMLInputElement).value).toBe("Long stay lease");
    expect((screen.getByLabelText(/Lease fee/i) as HTMLInputElement).value).toBe("300");
  });
});

describe("property Move-in tab: the move-in editor stores every edit", () => {
  it("title, lease type and the lease it is tied to survive the editor's save path and a re-read", async () => {
    const forms = [{ ...structuredClone(MOVE_IN_FORM_STARTERS[0]!), id: "mi-1", name: "Checklist", trigger: "manual" as const }];
    const original = { ...subWithForms(), moveInFormTemplates: forms } as unknown as ManagerListingSubmissionV1;
    // What the editor's footer Save hands the tab (cleanMoveInTemplateForSave of its draft), and what the tab writes.
    const draft = { ...forms[0]!, name: "  Short stay checklist ", ...moveInFormLeaseTypePatch("short-term", forms[0]!) };
    const next = upsertMoveInTemplate(readMoveInFormTemplates(original), cleanMoveInTemplateForSave(draft));
    const reread = await stored({ ...original, moveInFormTemplates: next }, original);
    const saved = readMoveInFormTemplates(reread).find((row) => row.id === "mi-1")!;
    expect(saved.name).toBe("Short stay checklist");
    expect(saved.leaseType).toBe("short-term");

    const tied = upsertMoveInTemplate(next, cleanMoveInTemplateForSave({ ...saved, ...moveInFormLeaseTypePatch("lease:l-long", saved) }));
    const rereadTied = await stored({ ...original, moveInFormTemplates: tied }, reread);
    const savedTied = readMoveInFormTemplates(rereadTied).find((row) => row.id === "mi-1")!;
    expect(savedTied.linkedLeaseTemplateIds).toEqual(["l-long"]);
    expect(moveInFormLeaseTypeValue(savedTied)).toBe("lease:l-long");
  });
});

describe("property Pricing tab: the pricing popup stores every edit through the server-confirmed save", () => {
  const openPricing = (sub: ManagerListingSubmissionV1, onSaved: () => void, onClose: () => void, showToast = vi.fn()) =>
    render(
      <PropertyRoomPricingWorkspace
        open
        onClose={onClose}
        subject={{ kind: "room", roomId: "room-7" }}
        sub={sub}
        saveTarget={{ mode: "listing", saveId: "mgr-house-1" }}
        managerUserId="mgr"
        propertyLabel="Test house"
        onSaved={onSaved}
        showToast={showToast}
      />,
    );
  const pricingSub = () =>
    normalizeManagerListingSubmissionV1({
      ...subWithForms(),
      allowedLeaseTerms: ["Long-term", "Month-to-Month", "Short-Term Stay"],
      rooms: [{ ...emptyRoom(0), id: "room-7", name: "Room 7", monthlyRent: 800 }],
    } as unknown as ManagerListingSubmissionV1);

  it("rent, nightly rate, a month-to-month surcharge and a custom fee survive Save and a re-read", async () => {
    persistOnServer.mockResolvedValue(true);
    const onSaved = vi.fn();
    const onClose = vi.fn();
    openPricing(pricingSub(), onSaved, onClose);
    const rent = screen.getByLabelText("Rent") as HTMLInputElement;
    fireEvent.focus(rent);
    fireEvent.change(rent, { target: { value: "950" } });
    const m2m = screen.getAllByLabelText(/month-to-month surcharge/i)[0] as HTMLInputElement;
    fireEvent.focus(m2m);
    fireEvent.change(m2m, { target: { value: "60" } });
    fireEvent.click(q('[data-attr="listing-v2-room-fee-add"]')!);
    const feeRow = Array.from(document.querySelectorAll('[data-attr="listing-v2-fee-row"]')).at(-1)!;
    fireEvent.change(feeRow.querySelector("input[aria-label='Fee name']")!, { target: { value: "Pet rent" } });
    const feeAmount = Array.from(feeRow.querySelectorAll("input")).find((input) => /amount/i.test(input.getAttribute("aria-label") ?? "")) as HTMLInputElement;
    fireEvent.focus(feeAmount);
    fireEvent.change(feeAmount, { target: { value: "35" } });
    // The Short term tab.
    fireEvent.click(q('[data-attr="listing-v2-rail-short-term"]') ?? q('[data-attr="listing-v2-rail-Short-Term Stay"]')!);
    const nightly = screen.getByLabelText("Nightly rate") as HTMLInputElement;
    fireEvent.focus(nightly);
    fireEvent.change(nightly, { target: { value: "55" } });

    fireEvent.click(q('[data-attr="property-room-pricing-save"]')!);
    await waitFor(() => expect(persistOnServer).toHaveBeenCalled());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSaved).toHaveBeenCalled();
    const handed = persistOnServer.mock.calls.at(-1)![2] as ManagerListingSubmissionV1;
    const reread = await stored(handed);
    const room = reread.rooms.find((row) => row.id === "room-7")!;
    expect(room.monthlyRent).toBe(950);
    expect(room.shortTermRent).toBe("55");
    expect(JSON.stringify(room)).toContain('"monthToMonthSurcharge":"60"');
    expect(((reread.customFees ?? []) as Array<{ label?: string; amount?: string }>).find((fee) => fee.label === "Pet rent")?.amount).toBe("35");
  });

  it("a save the server refuses keeps the popup open and says so, instead of claiming Pricing saved", async () => {
    persistOnServer.mockResolvedValue(false);
    const onSaved = vi.fn();
    const onClose = vi.fn();
    const showToast = vi.fn();
    openPricing(pricingSub(), onSaved, onClose, showToast);
    const rent = screen.getByLabelText("Rent") as HTMLInputElement;
    fireEvent.focus(rent);
    fireEvent.change(rent, { target: { value: "950" } });
    fireEvent.click(q('[data-attr="property-room-pricing-save"]')!);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Could not save pricing."));
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalledWith("Pricing saved.");
  });
});
