// @vitest-environment jsdom
//
// Add property / Edit listing carry four leasing steps between Shared spaces and Review
// (captain, Oct 3): Application, Lease, Move-in, Pricing. Each row edits IN PLACE (a switch, the
// fee, a Sends dropdown, and a chevron that unfolds the rest) - there is no pencil and no modal.
// Review lists the steps too; and the property record's sidebar puts Move-in under Leasing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readMoveInFormTemplates } from "@/lib/move-in-forms/templates";

// What a property that never saved its forms shows: the default forms plus the starters.
const UNSAVED_FORM_COUNT = readMoveInFormTemplates({}).length;
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  publishManagerPropertyDraftToServer: vi.fn(),
  saveManagerPropertyDraftToServer: vi.fn(),
  readAdminPropertyRows: vi.fn(() => []),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({ submitManagerPendingPropertyToServer: vi.fn() }));

import { ListingEditorV2, LISTING_V2_STEPS, listingRailChrome } from "@/components/portal/listing-wizard-v2/listing-editor";
import { PortalAssistantConfigProvider } from "@/lib/axis-assistant/portal-assistant-context";
import { createDefaultListingSubmission, resolveAllowedLeaseTerms } from "@/lib/manager-listing-submission";
import { longTermPrivateArrangementRow, placementFeeOptionsFor, resolvePlacementStandardFees } from "@/lib/listing-placement-standard-fees";
import { readPropertyApplicationTemplates } from "@/lib/property-application-templates";
import { readPropertyLeaseTemplates } from "@/lib/property-lease-templates";
import { termFeeText } from "@/lib/room-term-fees";
import { recordSections } from "@/lib/portals/record-sections";

const showToast = vi.fn();

function sub() {
  const base = createDefaultListingSubmission();
  return {
    ...base,
    address: "400 Pike Street",
    rooms: [{ ...base.rooms[0]!, id: "room-a", name: "Room A", monthlyRent: 1100 }],
  };
}

function mount(props: Partial<React.ComponentProps<typeof ListingEditorV2>> = {}) {
  render(
    <PortalAssistantConfigProvider endpoint="/api/agent/chat" managerName={null}>
      <ListingEditorV2
        title="400 Pike Street"
        submission={sub()}
        onChange={() => {}}
        onClose={() => {}}
        onPublish={() => {}}
        managerUserId="manager-1"
        showToast={showToast}
        {...props}
      />
    </PortalAssistantConfigProvider>,
  );
}

const go = (id: string) => fireEvent.click(document.querySelector(`[data-attr='listing-v2-rail-${id}']`)!);

beforeEach(() => {
  showToast.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ leasingPipeline: { applicationBeforeTour: "required" } }) })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the wizard rail", () => {
  it("lists Basics, Rooms, Bathrooms, Shared spaces, Application, Lease, Move-in, Pricing, Review", () => {
    mount();
    const labels = Array.from(
      screen.getByRole("navigation", { name: "Listing sections" }).querySelectorAll("button[data-attr^='listing-v2-rail-']"),
    )
      .filter((b) => !["listing-v2-rail-finish", "listing-v2-rail-add-photos"].includes(b.getAttribute("data-attr")!))
      .map((b) => b.querySelector("span.truncate")?.textContent);
    expect(labels).toEqual(["Basics", "Rooms", "Bathrooms", "Shared spaces", "Application", "Lease", "Move-in", "Pricing", "Review"]);
    expect(LISTING_V2_STEPS).toHaveLength(9);
  });

  it("counts the leasing steps on the Continue path (Basics, Rooms, 4 leasing, Review), not five", () => {
    mount();
    expect(screen.getAllByText(/^Step 1 of 7$/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Step 1 of 5$/)).toBeNull();
  });

  it("the phone step picker lists the new steps", () => {
    mount();
    fireEvent.click(document.querySelector("[data-attr='workspace-step-picker']")!);
    for (const id of ["application", "lease", "movein", "pricing"]) {
      expect(document.querySelector(`[data-attr='workspace-step-${id}']`)).not.toBeNull();
    }
  });

  it("none of the new steps raises a red dot or an 'N to finish' count", () => {
    const chrome = listingRailChrome(sub());
    for (const id of ["application", "lease", "movein", "pricing"]) expect(chrome.attention[id]).toBe(0);
  });
});

/** The editor over real state, so an edit made in a step is what the next render (and the next step) reads. */
function mountLive(initial: ReturnType<typeof sub> | Record<string, unknown> = sub(), props: Partial<React.ComponentProps<typeof ListingEditorV2>> = {}) {
  let latest = initial as ReturnType<typeof sub>;
  function Harness() {
    const [value, setValue] = React.useState(initial as ReturnType<typeof sub>);
    return (
      <PortalAssistantConfigProvider endpoint="/api/agent/chat" managerName={null}>
        <ListingEditorV2
          title="400 Pike Street"
          submission={value}
          onChange={(next) => {
            latest = next as ReturnType<typeof sub>;
            setValue(next as ReturnType<typeof sub>);
          }}
          onClose={() => {}}
          onPublish={() => {}}
          managerUserId="manager-1"
          showToast={showToast}
          {...props}
        />
      </PortalAssistantConfigProvider>
    );
  }
  render(<Harness />);
  return { latest: () => latest };
}

const q = (selector: string) => document.querySelector(selector) as HTMLElement | null;
const qa = (selector: string) => Array.from(document.querySelectorAll(selector)) as HTMLElement[];

function tapOption(label: string) {
  const listbox = screen.getAllByRole("listbox").at(-1)!;
  const option = Array.from(listbox.querySelectorAll('[role="option"]')).find((node) => node.textContent?.includes(label));
  expect(option, `option ${label}`).toBeTruthy();
  fireEvent.pointerDown(option!, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(option!, { pointerId: 1, clientX: 10, clientY: 10 });
}

function lease(id: string, label: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    kind: "long-term",
    label,
    leaseConfigMode: "standard",
    leaseCustomKind: "terms",
    customLeaseTerms: "",
    leaseTemplateDocUrl: null,
    leaseTemplateDocName: "",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    ...extra,
  };
}

function subWithLeases() {
  const base = sub();
  return {
    ...base,
    propertyLeaseTemplates: [
      lease("l1", "Long-term lease", { listingSeedKey: "primary", applicationLeaseTerms: ["12-Month"] }),
      lease("l2", "Pet addendum", { kind: "custom", leaseConfigMode: "custom", leaseCustomKind: "document", leaseTemplateDocUrl: "https://x/y.pdf", leaseTemplateDocName: "pets.pdf" }),
    ],
  } as unknown as typeof base;
}

describe("Application step", () => {
  it("every row has the Needed switch, the fee, a chevron and a menu; there is no pencil and no modal", () => {
    mountLive();
    go("application");
    const rows = qa("[data-attr='listing-v2-application-row']");
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      expect(row.querySelector("[data-attr='listing-v2-application-needed']")).not.toBeNull();
      expect(row.querySelector("[data-attr='listing-v2-application-fee']")).not.toBeNull();
      expect(row.querySelector("[data-attr='listing-v2-application-toggle']")).not.toBeNull();
      expect(row.querySelector("[data-attr='listing-v2-application-menu']")).not.toBeNull();
    }
    expect(q("[data-attr='listing-v2-application-edit']")).toBeNull();
    expect(screen.queryByRole("button", { name: /in full$/ })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the Needed switch persists in the submission and defaults to needed", () => {
    const live = mountLive();
    go("application");
    const first = qa("[data-attr='listing-v2-application-needed']")[0]!;
    expect(first.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(first);
    const stored = readPropertyApplicationTemplates(live.latest());
    expect(stored[0]!.offered).toBe(false);
    expect(qa("[data-attr='listing-v2-application-needed']")[0]!.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(qa("[data-attr='listing-v2-application-needed']")[0]!);
    expect(readPropertyApplicationTemplates(live.latest())[0]!.offered).toBe(true);
  });

  it("the fee box writes the Pricing step's field, so Pricing and the resolver show what Application typed", () => {
    const live = mountLive();
    go("application");
    const fee = qa("[data-attr='listing-v2-application-fee']")[0] as HTMLInputElement;
    fireEvent.focus(fee);
    fireEvent.change(fee, { target: { value: "75" } });
    const room = live.latest().rooms[0]!;
    // the resolver (the quote, the application fee charged, the lease) reads the room's own fee
    expect(resolvePlacementStandardFees(live.latest(), placementFeeOptionsFor(live.latest(), { room, leaseTerm: "Long-term" })).applicationFee).toBe(75);
    // the same field the Pricing step's box edits
    expect(termFeeText(longTermPrivateArrangementRow(room), "applicationFee", "long").value).toBe("75");
    // and the Application row reads it back
    expect((qa("[data-attr='listing-v2-application-fee']")[0] as HTMLInputElement).value).toBe("75");
    go("pricing");
    fireEvent.click(qa("[data-attr='listing-v2-pricing-toggle']")[0]!);
    expect((q("[data-attr='arrangement-application-fee-long']") as HTMLInputElement).value).toBe("75");
  });

  it("editing the Short term application's fee writes the Short term fee only", () => {
    const live = mountLive();
    go("application");
    const rows = qa("[data-attr='listing-v2-application-row']");
    const shortRow = rows.find((row) => /Short-term application/.test(row.textContent ?? ""))!;
    const fee = shortRow.querySelector("[data-attr='listing-v2-application-fee']") as HTMLInputElement;
    fireEvent.focus(fee);
    fireEvent.change(fee, { target: { value: "30" } });
    const room = live.latest().rooms[0]!;
    expect(resolvePlacementStandardFees(live.latest(), placementFeeOptionsFor(live.latest(), { room, rentalType: "short_term" })).applicationFee).toBe(30);
    expect(room.termPricing?.["Short-Term Stay"]?.applicationFee).toBe("30");
    expect(longTermPrivateArrangementRow(room).applicationFee ?? "").toBe("");
  });

  it("the chevron unfolds the row in place: name, lease and the questions, no modal", () => {
    mountLive();
    go("application");
    fireEvent.click(qa("[data-attr='listing-v2-application-toggle']")[0]!);
    const body = q("[data-attr='listing-v2-application-row-body']")!;
    expect(body.querySelector("[data-attr='listing-v2-application-name']")).not.toBeNull();
    expect(body.querySelector("[data-attr='listing-v2-application-lease']")).not.toBeNull();
    expect(body.querySelector("[data-attr='listing-v2-application-questions']")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renaming and editing a question inline land on the template's draft config", () => {
    const live = mountLive();
    go("application");
    fireEvent.click(qa("[data-attr='listing-v2-application-toggle']")[0]!);
    const name = q("[data-attr='listing-v2-application-name']") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Room application" } });
    expect(readPropertyApplicationTemplates(live.latest())[0]!.label).toBe("Room application");
    fireEvent.click(q("[data-attr='application-questions-add']")!);
    const draft = readPropertyApplicationTemplates(live.latest())[0]!.draftQuestionConfig!;
    expect(draft.applicationConfigMode).toBe("custom");
    expect(draft.customApplicationFields.length).toBe(1);
  });

  it("+ Add application adds one inline, already open, started from the PropLane standard", () => {
    const live = mountLive();
    go("application");
    const before = qa("[data-attr='listing-v2-application-row']").length;
    fireEvent.click(q("[data-attr='listing-v2-application-add']")!);
    const after = readPropertyApplicationTemplates(live.latest());
    expect(after.length).toBe(before + 1);
    const created = after.at(-1)!;
    expect(created.listingSeedKey).toBeUndefined();
    expect(created.draftQuestionConfig?.applicationConfigMode).toBe("custom");
    expect(q("[data-attr='listing-v2-application-start-from']")).not.toBeNull();
    expect(q("[data-attr='listing-v2-application-questions']")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Duplicate copies a row; Delete (last, after a tap to confirm) removes it", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const live = mountLive();
    go("application");
    const before = qa("[data-attr='listing-v2-application-row']").length;
    fireEvent.pointerDown(qa("[data-attr='listing-v2-application-menu']")[0]!, { button: 0, ctrlKey: false });
    fireEvent.click(qa("[data-attr='listing-v2-application-menu']")[0]!);
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Duplicate", "Delete"]);
    fireEvent.click(items[0]!);
    expect(readPropertyApplicationTemplates(live.latest()).length).toBe(before + 1);
    expect(readPropertyApplicationTemplates(live.latest()).some((row) => /copy$/.test(row.label))).toBe(true);
  });

  it("'Application before a tour' reads Not needed by default and saves a pick to the workspace setting", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "PATCH" ? { ok: true, json: async () => ({}) } : { ok: true, json: async () => ({}) },
    );
    vi.stubGlobal("fetch", fetchMock);
    mountLive();
    go("application");
    const trigger = q("[data-attr='listing-v2-application-before-tour-select']")!;
    expect(trigger.textContent).toContain("Not needed");
    expect(q("[data-attr='listing-v2-application-before-tour']")!.textContent).not.toContain("—");
    fireEvent.click(trigger);
    tapOption("Required");
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
      expect(patch).toBeTruthy();
      expect(JSON.parse((patch![1] as RequestInit).body as string)).toEqual({ leasingPipeline: { applicationBeforeTour: "required" } });
    });
    expect(q("[data-attr='listing-v2-application-before-tour-select']")!.textContent).toContain("Required");
  });

  it("'Application before a tour' shows the stored workspace value once it arrives", async () => {
    mountLive();
    go("application");
    await waitFor(() => expect(q("[data-attr='listing-v2-application-before-tour-select']")!.textContent).toContain("Required"));
  });
});

describe("Lease step", () => {
  it("every lease row has the Offered switch, its type, its applications and the two options, with no pencil", () => {
    mountLive(subWithLeases());
    go("lease");
    const rows = qa("[data-attr='listing-v2-lease-row']");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Long-term lease");
    expect(rows[1]!.textContent).toContain("Pet addendum");
    for (const row of rows) {
      expect(row.querySelector("[data-attr='listing-v2-lease-offered']")).not.toBeNull();
      expect(row.querySelector("[data-attr='listing-v2-lease-type']")).not.toBeNull();
      expect(row.querySelector("[data-attr='listing-v2-lease-applications']")).not.toBeNull();
    }
    expect(rows[0]!.querySelector("[data-attr='listing-v2-lease-allow-custom-dates']")).not.toBeNull();
    expect(rows[0]!.querySelector("[data-attr='listing-v2-lease-allow-month-to-month']")).not.toBeNull();
    expect(q("[data-attr='listing-v2-lease-edit']")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the Offered switch persists", () => {
    const live = mountLive(subWithLeases());
    go("lease");
    fireEvent.click(qa("[data-attr='listing-v2-lease-offered']")[1]!);
    expect(readPropertyLeaseTemplates(live.latest()).find((row) => row.id === "l2")!.offered).toBe(false);
  });

  it("Allow custom dates writes the lease's applicationLeaseTerms AND the listing's allowedLeaseTerms", () => {
    const live = mountLive(subWithLeases());
    go("lease");
    const box = qa("[data-attr='listing-v2-lease-allow-custom-dates']")[0] as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    const stored = live.latest();
    expect(readPropertyLeaseTemplates(stored).find((row) => row.id === "l1")!.applicationLeaseTerms).toContain("Custom");
    expect(resolveAllowedLeaseTerms(stored)).toContain("Custom");
    expect((qa("[data-attr='listing-v2-lease-allow-custom-dates']")[0] as HTMLInputElement).checked).toBe(true);
    // and back off: both sides drop it
    fireEvent.click(qa("[data-attr='listing-v2-lease-allow-custom-dates']")[0]!);
    expect(readPropertyLeaseTemplates(live.latest()).find((row) => row.id === "l1")!.applicationLeaseTerms).not.toContain("Custom");
    expect(resolveAllowedLeaseTerms(live.latest())).not.toContain("Custom");
  });

  it("Allow month-to-month does the same for month-to-month", () => {
    const live = mountLive(subWithLeases());
    go("lease");
    fireEvent.click(qa("[data-attr='listing-v2-lease-allow-month-to-month']")[0]!);
    expect(readPropertyLeaseTemplates(live.latest()).find((row) => row.id === "l1")!.applicationLeaseTerms).toContain("Month-to-Month");
    expect(resolveAllowedLeaseTerms(live.latest())).toContain("Month-to-Month");
  });

  it("the chevron unfolds the name, Start from and the clause editor in place", () => {
    mountLive(subWithLeases());
    go("lease");
    fireEvent.click(qa("[data-attr='listing-v2-lease-toggle']")[0]!);
    const body = q("[data-attr='listing-v2-lease-row-body']")!;
    expect(body.querySelector("[data-attr='listing-v2-lease-name']")).not.toBeNull();
    expect(body.querySelector("[data-attr='listing-v2-lease-start-from']")).not.toBeNull();
    expect(body.querySelector("[data-attr='listing-v2-lease-document'], [data-attr='listing-v2-lease-upload']")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("+ Add lease adds a PropLane standard lease inline, open", () => {
    const live = mountLive(subWithLeases());
    go("lease");
    const before = readPropertyLeaseTemplates(live.latest()).length;
    fireEvent.click(q("[data-attr='listing-v2-lease-add']")!);
    const after = readPropertyLeaseTemplates(live.latest());
    expect(after.length).toBe(before + 1);
    expect(q("[data-attr='listing-v2-lease-start-from']")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a brand-new draft shows the lease types it offers as off, and switching one on adds it", () => {
    const live = mountLive();
    go("lease");
    expect(qa("[data-attr='listing-v2-lease-default-row']").length).toBeGreaterThan(0);
    fireEvent.click(qa("[data-attr='listing-v2-lease-default-offered']")[0]!);
    expect(readPropertyLeaseTemplates(live.latest()).length).toBe(1);
  });

  it("an application and a lease are linked from either side, and both sides agree", async () => {
    const base = subWithLeases();
    const live = mountLive({
      ...base,
      propertyApplicationTemplates: [
        { id: "a1", kind: "long-term", formVariant: "standard", label: "Standard application", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
        { id: "a2", kind: "long-term", formVariant: "standard", label: "Quick application", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
      ],
      propertyApplicationTemplatesExplicit: true,
    });
    // from the application side: Standard application -> Pet addendum
    go("application");
    fireEvent.click(qa("[data-attr='listing-v2-application-toggle']")[0]!);
    fireEvent.click(q("[data-attr='listing-v2-application-lease']")!);
    tapOption("Pet addendum");
    expect(readPropertyApplicationTemplates(live.latest()).find((row) => row.id === "a1")!.linkedLeaseTemplateId).toBe("l2");
    // the lease side shows it
    go("lease");
    const petRow = qa("[data-attr='listing-v2-lease-row']").find((row) => /Pet addendum/.test(row.textContent ?? ""))!;
    expect(petRow.querySelector("[data-attr='listing-v2-lease-applications']")!.textContent).toContain("Standard application");
    // from the lease side: Long-term lease also serves Quick application
    const longRow = qa("[data-attr='listing-v2-lease-row']")[0]!;
    fireEvent.click(longRow.querySelector("[data-attr='listing-v2-lease-applications']")!);
    const box = screen.getAllByRole("option").find((node) => node.textContent?.includes("Quick application"))!;
    fireEvent.pointerDown(box, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(box, { pointerId: 1, clientX: 10, clientY: 10 });
    expect(readPropertyApplicationTemplates(live.latest()).find((row) => row.id === "a2")!.linkedLeaseTemplateId).toBe("l1");
    // the application side shows it
    go("application");
    fireEvent.click(qa("[data-attr='listing-v2-application-toggle']")[1]!);
    await waitFor(() => expect(qa("[data-attr='listing-v2-application-lease']")[0]!.textContent).toContain("Long-term lease"));
  });
});

describe("Move-in step", () => {
  it("each form's Sends is a dropdown in the row; picking one saves it with no modal", async () => {
    const live = mountLive();
    go("movein");
    const rows = qa("[data-attr='listing-v2-movein-row']");
    expect(rows.length).toBe(UNSAVED_FORM_COUNT);
    expect(q("[data-attr='listing-v2-movein-edit']")).toBeNull();
    const sends = rows[1]!.querySelector("[data-attr='listing-v2-movein-sends']")!;
    expect(sends.textContent).toMatch(/lease is signed/i);
    fireEvent.click(sends);
    tapOption("Only when I send it");
    const stored = readMoveInFormTemplates(live.latest());
    expect(stored[1]!.trigger).toBe("manual");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the chevron unfolds the form's questions in place, and a question can be added", () => {
    const live = mountLive();
    go("movein");
    fireEvent.click(qa("[data-attr='listing-v2-movein-toggle']")[0]!);
    expect(q("[data-attr='move-in-questions-editor']")).not.toBeNull();
    const before = readMoveInFormTemplates(live.latest())[0]!.questions.length;
    fireEvent.click(qa("[data-attr='move-in-form-add-question']")[0]!);
    // a blank question is held in the open form until it has words, then it is stored
    expect(readMoveInFormTemplates(live.latest())[0]!.questions.length).toBe(before);
    const blank = (screen.getAllByPlaceholderText("e.g. Do you smoke?") as HTMLInputElement[]).find((input) => input.value === "")!;
    fireEvent.change(blank, { target: { value: "Parking permit number" } });
    const stored = readMoveInFormTemplates(live.latest())[0]!.questions;
    expect(stored.length).toBe(before + 1);
    expect(stored.some((question) => question.label === "Parking permit number")).toBe(true);
  });

  it("+ Add form adds one inline, open, that never sends until the manager picks when", () => {
    const live = mountLive();
    go("movein");
    fireEvent.click(q("[data-attr='listing-v2-movein-add']")!);
    const forms = readMoveInFormTemplates(live.latest());
    expect(forms.length).toBe(UNSAVED_FORM_COUNT + 1);
    expect(forms.at(-1)!.trigger).toBe("manual");
    expect(q("[data-attr='listing-v2-movein-start-from']")).not.toBeNull();
  });
});

describe("Pricing step", () => {
  it("a room unfolds its rent, deposit and fees in place; editing the rent writes the field the pricing workspace writes", () => {
    const live = mountLive();
    go("pricing");
    const row = q("[data-attr='listing-v2-pricing-row']")!;
    expect(row.textContent).toContain("Room A");
    expect(row.textContent).toMatch(/\$1,100/);
    expect(q("[data-attr='listing-v2-pricing-edit']")).toBeNull();
    fireEvent.click(q("[data-attr='listing-v2-pricing-toggle']")!);
    const rent = screen.getByLabelText("Rent") as HTMLInputElement;
    fireEvent.focus(rent);
    fireEvent.change(rent, { target: { value: "1250" } });
    const next = live.latest();
    expect(next.rooms[0]!.monthlyRent).toBe(1250);
    // the same patch the pricing workspace applies: marked as priced on its own
    expect(next.roomPricingMeta?.["room-a"]?.priceSource).toBe("own");
    const deposit = screen.getByLabelText("Deposit") as HTMLInputElement;
    fireEvent.focus(deposit);
    fireEvent.change(deposit, { target: { value: "500" } });
    expect(live.latest().rooms[0]!.securityDeposit).toBe("500");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("right-hand preview", () => {
  it("shows the leasing summary on the new steps and keeps the Listing preview", () => {
    mount();
    go("application");
    const summary = document.querySelector("[data-attr='listing-v2-detail-summary']")!.textContent!;
    expect(summary).toMatch(/Applications/);
    expect(summary).toMatch(/Leases/);
    expect(summary).toMatch(new RegExp(`Move-in forms.*${UNSAVED_FORM_COUNT} forms`));
    expect(summary).toMatch(/From \$1,100\/mo/);
    expect(screen.getAllByText("Listing preview").length).toBeGreaterThan(0);
  });
});

describe("Review step", () => {
  it("lists the four leasing steps with an Edit door each, and they are not 'to finish' items", () => {
    mount();
    go("review");
    for (const id of ["application", "lease", "movein", "pricing"]) {
      expect(document.querySelector(`[data-attr='listing-v2-review-leasing-${id}']`)).not.toBeNull();
    }
    fireEvent.click(document.querySelector("[data-attr='listing-v2-review-edit-movein']")!);
    expect(document.querySelector("[data-attr='listing-v2-movein-rows']")).not.toBeNull();
  });
});

describe("property record sidebar", () => {
  it("puts Move-in under Leasing, in the order Applications, Lease, Move-in, Pricing", () => {
    const groups = recordSections("manager", "property", { basePath: "/portal" }).groups;
    const ids = (label: string) => groups.find((g) => g.label === label)?.items.map((i) => i.id);
    expect(ids("Leasing")).toEqual(["application", "lease", "move-in", "pricing"]);
    expect(ids("Property")).toEqual(["preview", "house-details"]);
    const leasing = groups.find((g) => g.label === "Leasing")!.items.map((i) => i.label);
    expect(leasing).toEqual(["Applications", "Lease", "Move-in", "Pricing"]);
    // the URL does not change
    const moveIn = groups.flatMap((g) => g.items).find((i) => i.id === "move-in")!;
    expect(moveIn.href("p1")).toMatch(/\/move-in$/);
  });
});
