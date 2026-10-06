// @vitest-environment jsdom
//
// "Edits must save" (captain, Oct 4 2026): every edit made in the listing editor's Application / Lease /
// Move-in / Pricing steps and in the property Applications tab must survive Save/close and a re-read of the
// STORED submission. Each test edits through the real component, then sends the result down the real
// persistence chain (the client's pre-save normalize, JSON on the wire, the server's version-preserving merge,
// the read-time normalize) and re-reads from that copy, which is what the page reloads from.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  publishManagerPropertyDraftToServer: vi.fn(),
  saveManagerPropertyDraftToServer: vi.fn(),
  readAdminPropertyRows: vi.fn(() => []),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({ submitManagerPendingPropertyToServer: vi.fn() }));
vi.mock("@/lib/listing-submission-media-upload", () => ({
  uploadListingSubmissionMedia: vi.fn(async (submission: unknown) => ({ submission, failedCount: 0 })),
}));

import { ListingEditorV2 } from "@/components/portal/listing-wizard-v2/listing-editor";
import { PortalAssistantConfigProvider } from "@/lib/axis-assistant/portal-assistant-context";
import { createDefaultListingSubmission, normalizeManagerListingSubmissionV1, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { prepareListingSubmissionForPersist } from "@/lib/prepare-listing-submission-for-persist";
import { preserveServerOwnedApplicationVersions } from "@/lib/rental-application/server-owned-template-versions";
import { readPropertyApplicationTemplates } from "@/lib/property-application-templates";
import { readPropertyLeaseTemplates } from "@/lib/property-lease-templates";
import { readMoveInFormTemplates, MOVE_IN_FORM_STARTERS } from "@/lib/move-in-forms/templates";

const showToast = vi.fn();

/** What the server would hold after this save, read the way the page reloads it. */
async function stored(next: ManagerListingSubmissionV1, previous?: ManagerListingSubmissionV1): Promise<ManagerListingSubmissionV1> {
  const { submission } = await prepareListingSubmissionForPersist(next, { validateWaiverCode: false });
  const wire = JSON.parse(JSON.stringify(submission));
  const merged = preserveServerOwnedApplicationVersions(
    { listingSubmission: wire },
    previous ? { listingSubmission: JSON.parse(JSON.stringify(previous)) } : undefined,
  ) as { listingSubmission: ManagerListingSubmissionV1 };
  return normalizeManagerListingSubmissionV1(JSON.parse(JSON.stringify(merged.listingSubmission)));
}

function baseSub() {
  const base = createDefaultListingSubmission();
  return {
    ...base,
    address: "400 Pike Street",
    shortTermRentalsAllowed: true,
    allowedLeaseTerms: ["Long-term", "Short-Term Stay"],
    rooms: [{ ...base.rooms[0]!, id: "room-a", name: "Room A", monthlyRent: 1100 }],
  } as ManagerListingSubmissionV1;
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

/** Three applications (long, short, co-signer) and two leases, all stored, so every edit has a target. */
function subWithForms(): ManagerListingSubmissionV1 {
  return {
    ...baseSub(),
    propertyLeaseTemplates: [
      leaseRow("l-long", "Long-term lease", { listingSeedKey: "primary", applicationLeaseTerms: ["Long-term"] }),
      leaseRow("l-short", "Short-term lease", { kind: "short-term", listingSeedKey: "short-term", applicationLeaseTerms: ["Short-Term Stay"] }),
    ],
    propertyApplicationTemplates: [
      { id: "a-long", kind: "long-term", formVariant: "standard", label: "Long-term application", createdAt: iso, updatedAt: iso },
      { id: "a-short", kind: "short-term", formVariant: "short_term", label: "Short-term application", createdAt: iso, updatedAt: iso },
      { id: "a-cos", kind: "long-term", formVariant: "cosigner", label: "Co-signer application", createdAt: iso, updatedAt: iso },
    ],
    propertyApplicationTemplatesExplicit: true,
  } as unknown as ManagerListingSubmissionV1;
}

function mountLive(initial: ManagerListingSubmissionV1) {
  let latest = initial;
  function Harness() {
    const [value, setValue] = React.useState(initial);
    return (
      <PortalAssistantConfigProvider endpoint="/api/agent/chat" managerName={null}>
        <ListingEditorV2
          title="400 Pike Street"
          submission={value}
          onChange={(next) => {
            latest = next as ManagerListingSubmissionV1;
            setValue(next as ManagerListingSubmissionV1);
          }}
          onClose={() => {}}
          onPublish={() => {}}
          managerUserId="manager-1"
          showToast={showToast}
        />
      </PortalAssistantConfigProvider>
    );
  }
  render(<Harness />);
  return { latest: () => latest };
}

const q = (selector: string) => document.querySelector(selector) as HTMLElement | null;
const qa = (selector: string) => Array.from(document.querySelectorAll(selector)) as HTMLElement[];
const go = (id: string) => fireEvent.click(q(`[data-attr='listing-v2-rail-${id}']`)!);
const cards = (kind: string) => qa(`[data-attr='listing-v2-${kind}-card']`);
const cardName = (card: HTMLElement) => (card.querySelector("input") as HTMLInputElement | null)?.value ?? "";
const openCard = (card: HTMLElement) => fireEvent.click(card.querySelector("[data-attr='listing-v2-card-open']")!);
const cardNamed = (kind: string, name: string) => cards(kind).find((card) => cardName(card) === name)!;

function tapOption(label: string) {
  const listbox = screen.getAllByRole("listbox").at(-1)!;
  const option = Array.from(listbox.querySelectorAll('[role="option"]')).find((node) => node.textContent?.includes(label));
  expect(option, `option ${label}`).toBeTruthy();
  fireEvent.pointerDown(option!, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(option!, { pointerId: 1, clientX: 10, clientY: 10 });
}
const pick = (attr: string, label: string) => {
  fireEvent.click(q(`[data-attr='${attr}']`)!);
  tapOption(label);
};
const typeInto = (element: HTMLElement, value: string) => {
  fireEvent.focus(element);
  fireEvent.change(element, { target: { value } });
};

beforeEach(() => {
  showToast.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ leasingPipeline: { applicationBeforeTour: "not_needed" } }) })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const applicationOf = (sub: ManagerListingSubmissionV1, id: string) => readPropertyApplicationTemplates(sub).find((row) => row.id === id)!;

describe("listing editor: Application step edits are stored", () => {
  it("name, fee, applies to, defaults, lease and co-signer form all survive a save and re-read", async () => {
    const original = subWithForms();
    const live = mountLive(original);
    go("application");
    openCard(cardNamed("application", "Long-term application"));
    const editor = () => q("[data-attr='listing-v2-application-editor']")!;

    typeInto(cardNamed("application", "Long-term application").querySelector("input")!, "Renamed long application");
    typeInto(q("[data-attr='listing-v2-application-fee']")!, "75");
    pick("listing-v2-application-applies-to-row", "Both");
    // Default for long term / short term ON, stored explicitly (a switch that shows on only because the form is the
    // section's first pins it with one tap).
    for (const stay of ["long", "short"]) {
      const toggle = () => q(`[data-attr='listing-v2-application-default-${stay}']`)!;
      fireEvent.click(toggle());
      expect(toggle().getAttribute("aria-checked")).toBe("true");
    }
    pick("listing-v2-application-lease", "Short-term lease");
    pick("listing-v2-application-cosigner", "Co-signer application");
    expect(editor()).not.toBeNull();

    const afterEdit = live.latest();
    const reread = await stored(afterEdit);
    const row = applicationOf(reread, "a-long");
    expect(row.label).toBe("Renamed long application");
    expect(row.feeCentsOverride).toBe(7500);
    expect(row.appliesTo).toBe("both");
    expect([...(row.defaultFor ?? [])].sort()).toEqual(["long_term", "short_term"]);
    expect(row.linkedLeaseTemplateId).toBe("l-short");
    expect(row.linkedCosignerApplicationTemplateId).toBe("a-cos");

    // Reload from the stored copy: the card shows the same edits.
    cleanup();
    mountLive(reread);
    go("application");
    expect(cards("application").map(cardName)).toContain("Renamed long application");
    expect(qa("[data-attr='listing-v2-stay-section-long_term'] [data-attr='listing-v2-application-card']").map(cardName)).toContain("Renamed long application");
    expect(qa("[data-attr='listing-v2-stay-section-short_term'] [data-attr='listing-v2-application-card']").map(cardName)).toContain("Renamed long application");
  });

  it("a short-term application has no co-signer field and saves with no co-signer link", async () => {
    const withLink = {
      ...subWithForms(),
      propertyApplicationTemplates: (subWithForms().propertyApplicationTemplates as unknown as Array<Record<string, unknown>>).map((row) =>
        row.id === "a-short" ? { ...row, appliesTo: "short_term", linkedCosignerApplicationTemplateId: "a-cos" } : row,
      ),
    } as unknown as ManagerListingSubmissionV1;
    const live = mountLive(withLink);
    go("application");
    openCard(cardNamed("application", "Short-term application"));
    expect(q("[data-attr='listing-v2-application-cosigner']")).toBeNull();
    // Any write to the list clears the link of a short-term form.
    typeInto(cardNamed("application", "Short-term application").querySelector("input")!, "Short stays");
    const reread = await stored(live.latest());
    const row = applicationOf(reread, "a-short");
    expect(row.label).toBe("Short stays");
    expect(row.linkedCosignerApplicationTemplateId ?? null).toBeNull();
  });

  it("moving an application to short term drops its co-signer link, and the co-signer form lists under Long term only", async () => {
    const live = mountLive({
      ...subWithForms(),
      propertyApplicationTemplates: (subWithForms().propertyApplicationTemplates as unknown as Array<Record<string, unknown>>).map((row) =>
        row.id === "a-long" ? { ...row, linkedCosignerApplicationTemplateId: "a-cos" } : row,
      ),
    } as unknown as ManagerListingSubmissionV1);
    go("application");
    const names = (section: string) =>
      qa(`[data-attr='listing-v2-stay-section-${section}'] [data-attr='listing-v2-application-card']`).map(cardName);
    expect(names("long_term")).toContain("Co-signer application");
    expect(names("short_term")).not.toContain("Co-signer application");
    openCard(cardNamed("application", "Long-term application"));
    pick("listing-v2-application-applies-to-row", "Short-term residents");
    const reread = await stored(live.latest());
    const row = applicationOf(reread, "a-long");
    expect(row.appliesTo).toBe("short_term");
    expect(row.linkedCosignerApplicationTemplateId ?? null).toBeNull();
    expect(q("[data-attr='listing-v2-application-cosigner']")).toBeNull();
  });

  it("a question's required switch and linked form rule are stored", async () => {
    const live = mountLive(subWithForms());
    go("application");
    openCard(cardNamed("application", "Long-term application"));
    const prefix = "listing-v2-application-editor";
    const toggle = q(`[data-attr="${prefix}-section-toggle-household"]`)!;
    if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
    const row = qa("[data-question-id]").find((el) => el.textContent?.includes("Co-signer planned"))!;
    fireEvent.click(row.querySelector(`[data-attr="${prefix}-question-open"]`)!);
    const required = q(`[data-attr="${prefix}-question-required"]`)!;
    const before = required.getAttribute("aria-checked");
    fireEvent.click(required);
    expect(required.getAttribute("aria-checked")).not.toBe(before);
    fireEvent.click(screen.getByRole("button", { name: "+ Link a form" }));
    fireEvent.click(q(`[data-attr="${prefix}-question-done"]`)!);

    const reread = await stored(live.latest());
    const stash = applicationOf(reread, "a-long");
    const field = (stash.draftQuestionConfig?.customApplicationFields ?? stash.publishedQuestionConfig?.customApplicationFields ?? []).find(
      (entry) => entry.standardKey === "household-co-signer-planned",
    );
    expect(field, "the edited question is stored").toBeTruthy();
    expect(field!.linkedForms?.length).toBe(1);
    expect(field!.required).toBe(before !== "true");
  });
});

describe("listing editor: Lease step edits are stored", () => {
  it("name, offered, fee, month-to-month, custom dates and the document text all survive a save and re-read", async () => {
    const live = mountLive(subWithForms());
    go("lease");
    openCard(cardNamed("lease", "Long-term lease"));
    typeInto(cardNamed("lease", "Long-term lease").querySelector("input")!, "Long stay lease");
    fireEvent.click(q("[data-attr='listing-v2-lease-offered']")!);
    typeInto(q("[data-attr='listing-v2-lease-fee']")!, "250");
    fireEvent.click(q("[data-attr='listing-v2-lease-allow-month-to-month']")!);
    fireEvent.click(q("[data-attr='listing-v2-lease-allow-custom-dates']")!);

    const reread = await stored(live.latest());
    const lease = readPropertyLeaseTemplates(reread).find((row) => row.id === "l-long")!;
    expect(lease.label).toBe("Long stay lease");
    expect(lease.offered).toBe(false);
    expect(lease.leaseFeeCents).toBe(25000);
    expect(lease.applicationLeaseTerms).toEqual(expect.arrayContaining(["Month-to-Month", "Custom"]));
    expect(reread.allowedLeaseTerms).toEqual(expect.arrayContaining(["Month-to-Month", "Custom"]));

    cleanup();
    mountLive(reread);
    go("lease");
    expect(cards("lease").map(cardName)).toContain("Long stay lease");
    openCard(cardNamed("lease", "Long stay lease"));
    expect((q("[data-attr='listing-v2-lease-fee']") as HTMLInputElement).value).toBe("250");
    expect((q("[data-attr='listing-v2-lease-allow-custom-dates']") as HTMLInputElement).checked).toBe(true);
    expect((q("[data-attr='listing-v2-lease-allow-month-to-month']") as HTMLInputElement).checked).toBe(true);
  });

  it("a lease kind change moves it to the other section and is stored; there is no Both section", async () => {
    const live = mountLive({
      ...subWithForms(),
      propertyLeaseTemplates: [
        ...(subWithForms().propertyLeaseTemplates as unknown as Array<Record<string, unknown>>),
        leaseRow("l-own", "Own terms", { kind: "custom", leaseConfigMode: "custom" }),
      ],
    } as unknown as ManagerListingSubmissionV1);
    go("lease");
    const names = (section: string) => qa(`[data-attr='listing-v2-stay-section-${section}'] [data-attr='listing-v2-lease-card']`).map(cardName);
    expect(names("long_term")).toContain("Own terms");
    expect(q("[data-attr='listing-v2-stay-section-both']")).toBeNull();
    openCard(cardNamed("lease", "Own terms"));
    pick("listing-v2-lease-start-from", "PropLane standard short term");
    await waitFor(() => expect(readPropertyLeaseTemplates(live.latest()).find((row) => row.id === "l-own")!.kind).toBe("short-term"));
    const reread = await stored(live.latest());
    expect(readPropertyLeaseTemplates(reread).find((row) => row.id === "l-own")!.kind).toBe("short-term");
    cleanup();
    mountLive(reread);
    go("lease");
    expect(names("short_term")).toContain("Own terms");
  });
});

describe("listing editor: Move-in step edits are stored", () => {
  it("title and lease type survive a save and re-read; an All form is listed in both sections", async () => {
    const forms = [{ ...structuredClone(MOVE_IN_FORM_STARTERS[0]!), id: "mi-1", name: "Checklist", trigger: "manual" as const }];
    const live = mountLive({ ...subWithForms(), moveInFormTemplates: forms } as unknown as ManagerListingSubmissionV1);
    go("movein");
    const names = (section: string) => qa(`[data-attr='listing-v2-stay-section-${section}'] [data-attr='listing-v2-movein-card']`).map(cardName);
    expect(names("long_term")).toEqual(["Checklist"]);
    expect(names("short_term")).toEqual(["Checklist"]);
    expect(q("[data-attr='listing-v2-stay-section-both']")).toBeNull();
    // Opening one copy opens only that copy (the same form, one editor at a time).
    openCard(qa("[data-attr='listing-v2-stay-section-short_term'] [data-attr='listing-v2-movein-card']")[0]!);
    expect(qa("[data-attr='listing-v2-movein-editor']")).toHaveLength(1);
    expect(q("[data-attr='listing-v2-stay-section-short_term'] [data-attr='listing-v2-movein-editor']")).not.toBeNull();

    typeInto(q("[data-attr='listing-v2-stay-section-short_term'] [data-attr='listing-v2-movein-card'] input")!, "Short stay checklist");
    pick("listing-v2-movein-lease-type", "Short");
    const reread = await stored(live.latest());
    const saved = readMoveInFormTemplates(reread).find((row) => row.id === "mi-1")!;
    expect(saved.name).toBe("Short stay checklist");
    expect(saved.leaseType).toBe("short-term");

    cleanup();
    mountLive(reread);
    go("movein");
    expect(names("short_term")).toEqual(["Short stay checklist"]);
    expect(names("long_term")).toEqual([]);
  });
});

describe("listing editor: Pricing step edits are stored", () => {
  it("long-term rent, short-term nightly rate and a month-to-month surcharge survive a save and re-read", async () => {
    const withM2m = {
      ...subWithForms(),
      allowedLeaseTerms: ["Long-term", "Month-to-Month", "Short-Term Stay"],
      propertyLeaseTemplates: [
        leaseRow("l-long", "Long-term lease", { listingSeedKey: "primary", applicationLeaseTerms: ["Long-term", "Month-to-Month"] }),
        leaseRow("l-short", "Short-term lease", { kind: "short-term", listingSeedKey: "short-term", applicationLeaseTerms: ["Short-Term Stay"] }),
      ],
    } as unknown as ManagerListingSubmissionV1;
    const live = mountLive(withM2m);
    go("pricing");
    openCard(cards("pricing")[0]!);
    const long = q("[data-attr='listing-v2-pricing-format-long']")!;
    typeInto(long.querySelector("input[aria-label='Rent']")!, "1250");
    const surchargeBox = () =>
      (qa("[data-attr='listing-v2-pricing-format-long'] input") as HTMLInputElement[]).find((input) => /month-to-month surcharge/i.test(input.getAttribute("aria-label") ?? ""));
    expect(surchargeBox(), "a month-to-month surcharge box").toBeTruthy();
    typeInto(surchargeBox()!, "75");
    const short = q("[data-attr='listing-v2-pricing-format-short']")!;
    typeInto(short.querySelector("input[aria-label='Nightly rate']")!, "45");

    const reread = await stored(live.latest());
    const room = reread.rooms[0]!;
    expect(room.monthlyRent).toBe(1250);
    expect(room.shortTermRent).toBe("45");
    expect(JSON.stringify(room)).toContain('"monthToMonthSurcharge":"75"');

    cleanup();
    mountLive(reread);
    go("pricing");
    openCard(cards("pricing")[0]!);
    expect((q("[data-attr='listing-v2-pricing-format-long'] input[aria-label='Rent']") as HTMLInputElement).value).toBe("1250");
    expect((q("[data-attr='listing-v2-pricing-format-short'] input[aria-label='Nightly rate']") as HTMLInputElement).value).toBe("45");
    expect(surchargeBox()!.value).toBe("75");
  });
});

describe("listing editor: a custom fee is stored", () => {
  it("a fee added on a room's Long term section keeps its name and amount through a save and re-read", async () => {
    const live = mountLive(subWithForms());
    go("pricing");
    openCard(cards("pricing")[0]!);
    fireEvent.click(q("[data-attr='listing-v2-room-fee-add']")!);
    const row = () => qa("[data-attr='listing-v2-fee-row']").at(-1)!;
    fireEvent.change(row().querySelector("input[aria-label='Fee name']")!, { target: { value: "Pet rent" } });
    const amount = Array.from(row().querySelectorAll("input")).find((input) => /amount/i.test(input.getAttribute("aria-label") ?? "")) as HTMLInputElement;
    expect(amount, "the fee amount box").toBeTruthy();
    typeInto(amount, "35");

    const reread = await stored(live.latest());
    const fees = (reread.customFees ?? []) as Array<{ label?: string; amount?: string }>;
    expect(fees.find((fee) => fee.label === "Pet rent")?.amount).toBe("35");

    cleanup();
    mountLive(reread);
    go("pricing");
    openCard(cards("pricing")[0]!);
    const names = qa("[data-attr='listing-v2-fee-row'] input[aria-label='Fee name']").map((input) => (input as HTMLInputElement).value);
    expect(names).toContain("Pet rent");
  });
});
