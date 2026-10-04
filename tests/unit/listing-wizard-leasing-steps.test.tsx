// @vitest-environment jsdom
//
// Add property / Edit listing carry four leasing steps between Shared spaces and Review
// (captain, Oct 3): Application, Lease, Move-in, Pricing. Each row edits IN PLACE (a switch, the
// fee, a Sends dropdown, and a chevron that unfolds the rest) - there is no pencil and no modal.
// Review lists the steps too; and the property record's sidebar puts Move-in under Leasing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOVE_IN_FORM_STARTERS, readMoveInFormTemplates } from "@/lib/move-in-forms/templates";

// What a property that never saved its forms shows: the default forms plus the starters.
// Move-in forms exist only once a manager adds them (claude-3, Oct 3), so the Move-in step is
// exercised on a property that saved two: a manual one and one that sends when the lease is signed.
const SAVED_MOVE_IN_FORMS = [
  { ...structuredClone(MOVE_IN_FORM_STARTERS[0]!), trigger: "manual" as const },
  { ...structuredClone(MOVE_IN_FORM_STARTERS[1] ?? MOVE_IN_FORM_STARTERS[0]!), id: "saved-lease-signed", trigger: "lease-signed" as const },
];
const UNSAVED_FORM_COUNT = SAVED_MOVE_IN_FORMS.length;
const withMoveInForms = () => ({ ...sub(), moveInFormTemplates: SAVED_MOVE_IN_FORMS });
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

/** Opens a card the way the Rooms step does: tap its facts line (or ⋯ → Edit). */
function openCard(card: HTMLElement) {
  fireEvent.click(card.querySelector("[data-attr='listing-v2-card-open']")!);
}
/** A card's name is the input in its header (like a room's). */
const cardName = (card: HTMLElement) => (card.querySelector("input") as HTMLInputElement | null)?.value ?? "";
const cards = (kind: string) => qa(`[data-attr='listing-v2-${kind}-card']`);
const headingText = () => q(".pr9-top h2")!.textContent;
/** The step's own heading (Pricing has no round + of its own, so no .pr9-top row). */
const stepHeadingText = () => document.querySelector("h2")!.textContent;

async function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
  return screen.findAllByRole("menuitem");
}

describe("Application step", () => {
  it("is the Rooms pattern: a count heading with the round +, one card per application with a menu and plain facts", () => {
    mountLive();
    go("application");
    expect(headingText()).toBe("3 applications");
    expect(q(".pr9-top [data-attr='listing-v2-add-application-icon']")).not.toBeNull();
    const list = cards("application");
    expect(list).toHaveLength(3);
    for (const card of list) {
      expect(card.className).toContain("pr9-card");
      expect(card.querySelector("[data-attr='listing-v2-application-menu']")).not.toBeNull();
      expect(card.querySelector(".pr9-facts")).not.toBeNull();
      // closed: nothing else, no pills, no pencil, no modal
      expect(card.querySelector("[data-attr='listing-v2-application-fee']")).toBeNull();
    }
    expect(list[0]!.textContent).toMatch(/No fee|\$\d+/);
    expect(list[0]!.textContent).toMatch(/\d+ questions?/);
    expect(q("[data-attr='listing-v2-application-edit']")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the menu is Edit, Duplicate and a red Delete last", async () => {
    mountLive();
    go("application");
    const items = await openMenu(q("[data-attr='listing-v2-application-menu']")!);
    expect(items.map((item) => item.textContent)).toEqual(["Edit", "Duplicate", "Delete"]);
    expect(items[2]!.className).toContain("text-red");
  });

  it("opening a card unfolds the editor in place: Needed, fee, lease, questions; Done closes it", () => {
    mountLive();
    go("application");
    openCard(cards("application")[0]!);
    const editor = q("[data-attr='listing-v2-application-editor']")!;
    expect(editor.querySelector("[data-attr='listing-v2-application-needed']")).not.toBeNull();
    expect(editor.querySelector("[data-attr='listing-v2-application-fee']")).not.toBeNull();
    expect(editor.querySelector("[data-attr='listing-v2-application-lease']")).not.toBeNull();
    expect(editor.querySelector("[data-attr='listing-v2-application-questions']")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(q("[data-attr='listing-v2-application-card-done']")!);
    expect(q("[data-attr='listing-v2-application-editor']")).toBeNull();
  });

  it("the Needed switch persists in the submission and defaults to needed", () => {
    const live = mountLive();
    go("application");
    openCard(cards("application")[0]!);
    const toggle = q("[data-attr='listing-v2-application-needed']")!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(readPropertyApplicationTemplates(live.latest())[0]!.offered).toBe(false);
    expect(q("[data-attr='listing-v2-application-needed']")!.getAttribute("aria-checked")).toBe("false");
    expect(cards("application")[0]!.textContent).toContain("Not needed");
    fireEvent.click(q("[data-attr='listing-v2-application-needed']")!);
    expect(readPropertyApplicationTemplates(live.latest())[0]!.offered).toBe(true);
  });

  it("the fee box writes the Pricing step's field, so Pricing and the resolver show what Application typed", () => {
    const live = mountLive();
    go("application");
    openCard(cards("application")[0]!);
    const fee = q("[data-attr='listing-v2-application-fee']") as HTMLInputElement;
    fireEvent.focus(fee);
    fireEvent.change(fee, { target: { value: "75" } });
    const room = live.latest().rooms[0]!;
    // the resolver (the quote, the application fee charged, the lease) reads the room's own fee
    expect(resolvePlacementStandardFees(live.latest(), placementFeeOptionsFor(live.latest(), { room, leaseTerm: "Long-term" })).applicationFee).toBe(75);
    // the same field the Pricing step's box edits
    expect(termFeeText(longTermPrivateArrangementRow(room), "applicationFee", "long").value).toBe("75");
    // and the Application card reads it back, in its facts too
    expect((q("[data-attr='listing-v2-application-fee']") as HTMLInputElement).value).toBe("75");
    expect(cards("application")[0]!.querySelector(".pr9-facts")!.textContent).toContain("$75");
    go("pricing");
    openCard(cards("pricing")[0]!);
    expect((qa("[data-attr='arrangement-application-fee-long']")[0] as HTMLInputElement).value).toBe("75");
  });

  it("editing the Short term application's fee writes the Short term fee only", () => {
    const live = mountLive();
    go("application");
    const shortCard = cards("application").find((card) => /Short-term application/.test(cardName(card)))!;
    openCard(shortCard);
    const fee = q("[data-attr='listing-v2-application-fee']") as HTMLInputElement;
    fireEvent.focus(fee);
    fireEvent.change(fee, { target: { value: "30" } });
    const room = live.latest().rooms[0]!;
    expect(resolvePlacementStandardFees(live.latest(), placementFeeOptionsFor(live.latest(), { room, rentalType: "short_term" })).applicationFee).toBe(30);
    expect(room.termPricing?.["Short-Term Stay"]?.applicationFee).toBe("30");
    expect(longTermPrivateArrangementRow(room).applicationFee ?? "").toBe("");
  });

  it("renaming and editing a question inline land on the template's draft config", () => {
    const live = mountLive();
    go("application");
    openCard(cards("application")[0]!);
    const name = screen.getByLabelText("Name for application 1") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Room application" } });
    expect(readPropertyApplicationTemplates(live.latest())[0]!.label).toBe("Room application");
    fireEvent.click(q("[data-attr='application-questions-add']")!);
    const draft = readPropertyApplicationTemplates(live.latest())[0]!.draftQuestionConfig!;
    expect(draft.applicationConfigMode).toBe("custom");
    expect(draft.customApplicationFields.length).toBe(1);
  });

  it("a duplicate or empty name is not saved", () => {
    const live = mountLive();
    go("application");
    openCard(cards("application")[0]!);
    const name = screen.getByLabelText("Name for application 1") as HTMLInputElement;
    const before = readPropertyApplicationTemplates(live.latest()).length ? readPropertyApplicationTemplates(live.latest())[0]!.label : "";
    fireEvent.change(name, { target: { value: "" } });
    expect(screen.getByRole("alert").textContent).toMatch(/Enter a name/);
    if (before) expect(readPropertyApplicationTemplates(live.latest())[0]!.label).toBe(before);
  });

  it("+ offers Build from PropLane standard and Upload a PDF; the first adds one inline, already open, started from the standard", async () => {
    const live = mountLive();
    go("application");
    const choices = await openMenu(q("[data-attr='listing-v2-add-application-icon']")!);
    expect(choices.map((item) => item.textContent)).toEqual(["Build from PropLane standard", "Upload a PDF"]);
    fireEvent.click(choices[0]!);
    expect(headingText()).toBe("4 applications");
    const created = readPropertyApplicationTemplates(live.latest()).at(-1)!;
    expect(created.listingSeedKey).toBeUndefined();
    expect(created.draftQuestionConfig?.applicationConfigMode).toBe("custom");
    expect(q("[data-attr='listing-v2-application-start-from']")).not.toBeNull();
    expect(q("[data-attr='listing-v2-application-questions']")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Duplicate copies a card and opens the copy", async () => {
    const live = mountLive();
    go("application");
    const items = await openMenu(q("[data-attr='listing-v2-application-menu']")!);
    fireEvent.click(items[1]!);
    expect(readPropertyApplicationTemplates(live.latest()).some((row) => /copy$/.test(row.label))).toBe(true);
    expect(headingText()).toBe("4 applications");
  });

  it("Delete (after a tap to confirm) removes a card", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const live = mountLive();
    go("application");
    const items = await openMenu(q("[data-attr='listing-v2-application-menu']")!);
    fireEvent.click(items[2]!);
    await waitFor(() => expect(readPropertyApplicationTemplates(live.latest()).length).toBe(2));
    expect(headingText()).toBe("2 applications");
  });

  it("'Application before a tour' is one settings row under the cards: Not needed by default, a pick saves to the workspace", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    mountLive();
    go("application");
    const row = q("[data-attr='listing-v2-application-before-tour']")!;
    const trigger = row.querySelector("[data-attr='listing-v2-application-before-tour-select']")!;
    expect(trigger.textContent).toContain("Not needed");
    expect(row.textContent).not.toContain("—");
    fireEvent.click(trigger);
    tapOption("Required");
    await waitFor(() => {
      const patch = (fetchMock.mock.calls as unknown as Array<[string, RequestInit?]>).find(([, init]) => init?.method === "PATCH");
      expect(patch).toBeTruthy();
      expect(JSON.parse(patch![1]!.body as string)).toEqual({ leasingPipeline: { applicationBeforeTour: "required" } });
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
  it("is the Rooms pattern: a count heading with the round +, a card per lease with a menu and its facts", () => {
    mountLive(subWithLeases());
    go("lease");
    // The heading counts every lease card shown: two leases and the short-term type with none yet.
    expect(headingText()).toBe("3 leases");
    expect(q(".pr9-top [data-attr='listing-v2-add-lease-icon']")).not.toBeNull();
    const list = cards("lease");
    expect(list).toHaveLength(2);
    expect(list[0]!.textContent).toContain("Long-term");
    expect(cardName(list[0]!)).toBe("Long-term lease");
    expect(cardName(list[1]!)).toBe("Pet addendum");
    for (const card of list) {
      expect(card.className).toContain("pr9-card");
      expect(card.querySelector("[data-attr='listing-v2-lease-menu']")).not.toBeNull();
    }
    expect(q("[data-attr='listing-v2-lease-edit']")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("an open lease has Offered, Start from, its applications, the two options and the clauses", () => {
    mountLive(subWithLeases());
    go("lease");
    openCard(cards("lease")[0]!);
    const editor = q("[data-attr='listing-v2-lease-editor']")!;
    for (const attr of ["offered", "start-from", "applications", "allow-custom-dates", "allow-month-to-month"]) {
      expect(editor.querySelector(`[data-attr='listing-v2-lease-${attr}']`), attr).not.toBeNull();
    }
    expect(editor.querySelector("[data-attr='listing-v2-lease-document'], [data-attr='listing-v2-lease-upload']")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the Offered switch persists", () => {
    const live = mountLive(subWithLeases());
    go("lease");
    openCard(cards("lease")[1]!);
    fireEvent.click(q("[data-attr='listing-v2-lease-offered']")!);
    expect(readPropertyLeaseTemplates(live.latest()).find((row) => row.id === "l2")!.offered).toBe(false);
    expect(cards("lease")[1]!.textContent).toContain("Not offered");
  });

  it("Allow custom dates writes the lease's applicationLeaseTerms AND the listing's allowedLeaseTerms", () => {
    const live = mountLive(subWithLeases());
    go("lease");
    openCard(cards("lease")[0]!);
    const box = q("[data-attr='listing-v2-lease-allow-custom-dates']") as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    const stored = live.latest();
    expect(readPropertyLeaseTemplates(stored).find((row) => row.id === "l1")!.applicationLeaseTerms).toContain("Custom");
    expect(resolveAllowedLeaseTerms(stored)).toContain("Custom");
    expect((q("[data-attr='listing-v2-lease-allow-custom-dates']") as HTMLInputElement).checked).toBe(true);
    expect(cards("lease")[0]!.textContent).toContain("Custom dates");
    fireEvent.click(q("[data-attr='listing-v2-lease-allow-custom-dates']")!);
    expect(readPropertyLeaseTemplates(live.latest()).find((row) => row.id === "l1")!.applicationLeaseTerms).not.toContain("Custom");
    expect(resolveAllowedLeaseTerms(live.latest())).not.toContain("Custom");
  });

  it("Allow month-to-month does the same for month-to-month", () => {
    const live = mountLive(subWithLeases());
    go("lease");
    openCard(cards("lease")[0]!);
    fireEvent.click(q("[data-attr='listing-v2-lease-allow-month-to-month']")!);
    expect(readPropertyLeaseTemplates(live.latest()).find((row) => row.id === "l1")!.applicationLeaseTerms).toContain("Month-to-Month");
    expect(resolveAllowedLeaseTerms(live.latest())).toContain("Month-to-Month");
    expect(cards("lease")[0]!.textContent).toContain("Month-to-month");
  });

  it("+ offers Add PropLane standard and Upload a PDF; the first adds a standard lease inline, open", async () => {
    const live = mountLive(subWithLeases());
    go("lease");
    const choices = await openMenu(q("[data-attr='listing-v2-add-lease-icon']")!);
    expect(choices.map((item) => item.textContent)).toEqual(["Add PropLane standard", "Upload a PDF"]);
    fireEvent.click(choices[0]!);
    expect(readPropertyLeaseTemplates(live.latest()).length).toBe(3);
    expect(headingText()).toBe("4 leases");
    expect(q("[data-attr='listing-v2-lease-start-from']")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a lease type with no lease yet is a Rooms-style card: counted, 'Not added yet', a menu, no switch on its face", async () => {
    const live = mountLive();
    go("lease");
    const defaults = qa("[data-attr='listing-v2-lease-default-card']");
    expect(defaults.length).toBeGreaterThan(0);
    // The heading counts the cards shown, not only the leases that exist.
    expect(headingText()).toBe(`${defaults.length} leases`);
    for (const card of defaults) {
      expect(card.className).toContain("pr9-card");
      expect(card.querySelector(".pr9-facts")!.textContent).toBe("Not added yet");
      expect(card.querySelector("[data-attr='listing-v2-lease-default-menu']")).not.toBeNull();
      expect(card.querySelector("[role='switch'], input[type='checkbox'], [data-attr='listing-v2-lease-default-offered']")).toBeNull();
    }
    const items = await openMenu(defaults[0]!.querySelector("[data-attr='listing-v2-lease-default-menu']")!);
    expect(items.map((item) => item.textContent)).toEqual(["Add PropLane standard", "Upload a PDF"]);
    fireEvent.click(items[0]!);
    expect(readPropertyLeaseTemplates(live.latest()).length).toBe(1);
  });

  it("a lease's Offered switch lives inside the opened card, never on its face; its menu is Edit, Duplicate, Delete", async () => {
    mountLive(subWithLeases());
    go("lease");
    const first = cards("lease")[0]!;
    expect(first.querySelector("[data-attr='listing-v2-lease-offered']")).toBeNull();
    const items = await openMenu(first.querySelector("[data-attr='listing-v2-lease-menu']")!);
    expect(items.map((item) => item.textContent)).toEqual(["Edit", "Duplicate", "Delete"]);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    openCard(cards("lease")[0]!);
    expect(cards("lease")[0]!.querySelector("[data-attr='listing-v2-lease-offered']")).not.toBeNull();
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
    openCard(cards("application")[0]!);
    fireEvent.click(q("[data-attr='listing-v2-application-lease']")!);
    tapOption("Pet addendum");
    expect(readPropertyApplicationTemplates(live.latest()).find((row) => row.id === "a1")!.linkedLeaseTemplateId).toBe("l2");
    expect(cards("application")[0]!.textContent).toContain("Pet addendum");
    // the lease side shows it, in its facts
    go("lease");
    const petCard = cards("lease").find((card) => /Pet addendum/.test(cardName(card)))!;
    expect(petCard.querySelector(".pr9-facts")!.textContent).toContain("Standard application");
    // from the lease side: Long-term lease also serves Quick application
    openCard(cards("lease")[0]!);
    fireEvent.click(q("[data-attr='listing-v2-lease-applications']")!);
    const box = screen.getAllByRole("option").find((node) => node.textContent?.includes("Quick application"))!;
    fireEvent.pointerDown(box, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(box, { pointerId: 1, clientX: 10, clientY: 10 });
    expect(readPropertyApplicationTemplates(live.latest()).find((row) => row.id === "a2")!.linkedLeaseTemplateId).toBe("l1");
    // the application side shows it
    go("application");
    expect(cards("application")[1]!.textContent).toContain("Long-term lease");
  });
});

describe("Move-in step", () => {
  it("is the Rooms pattern: a count heading with the round +, a card per form with its questions and when it sends", () => {
    mountLive(withMoveInForms());
    go("movein");
    expect(headingText()).toBe(`${UNSAVED_FORM_COUNT} move-in forms`);
    expect(q(".pr9-top [data-attr='listing-v2-add-movein-icon']")).not.toBeNull();
    const list = cards("movein");
    expect(list.length).toBe(UNSAVED_FORM_COUNT);
    expect(list[1]!.querySelector(".pr9-facts")!.textContent).toMatch(/\d+ questions?.*lease is signed/i);
    expect(q("[data-attr='listing-v2-movein-edit']")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("an open form has Sends as a dropdown; picking one saves it with no modal", () => {
    const live = mountLive(withMoveInForms());
    go("movein");
    openCard(cards("movein")[1]!);
    const sends = q("[data-attr='listing-v2-movein-sends']")!;
    expect(sends.textContent).toMatch(/lease is signed/i);
    fireEvent.click(sends);
    tapOption("Only when I send it");
    expect(readMoveInFormTemplates(live.latest())[1]!.trigger).toBe("manual");
    expect(cards("movein")[1]!.querySelector(".pr9-facts")!.textContent).toMatch(/Sent by hand/);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("an open form unfolds its questions in place, and a question can be added", () => {
    const live = mountLive(withMoveInForms());
    go("movein");
    openCard(cards("movein")[0]!);
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

  it("+ offers Build a form, Upload a PDF and Start from a template; Build adds a form inline, open, that never sends until the manager picks when", async () => {
    const live = mountLive(withMoveInForms());
    go("movein");
    const choices = await openMenu(q("[data-attr='listing-v2-add-movein-icon']")!);
    expect(choices.map((item) => item.textContent)).toEqual(["Build a form", "Upload a PDF", "Start from a template"]);
    fireEvent.click(choices[0]!);
    const forms = readMoveInFormTemplates(live.latest());
    expect(forms.length).toBe(UNSAVED_FORM_COUNT + 1);
    expect(forms.at(-1)!.trigger).toBe("manual");
    expect(q("[data-attr='listing-v2-movein-start-from']")).not.toBeNull();
  });

  it("the menu is Edit, Duplicate and a red Delete last", async () => {
    mountLive(withMoveInForms());
    go("movein");
    const items = await openMenu(q("[data-attr='listing-v2-movein-menu']")!);
    expect(items.map((item) => item.textContent)).toEqual(["Edit", "Duplicate", "Delete"]);
  });
});

describe("Move-in step, empty", () => {
  it("shows the standard empty card, with no plain line and no extra add button", () => {
    mountLive();
    go("movein");
    expect(headingText()).toBe("0 move-in forms");
    const empty = q("[data-attr='listing-v2-movein-empty']")!;
    expect(empty).not.toBeNull();
    expect(empty.textContent).toContain("No move-in forms yet");
    expect(empty.querySelector("button, a")).toBeNull();
    // the round + at the top right is the only add
    expect(qa("[data-attr='listing-v2-add-movein-icon']")).toHaveLength(1);
    expect(document.querySelector("p.text-muted")?.textContent ?? "").not.toContain("No move-in forms yet");
  });
});

describe("Pricing step", () => {
  it("the heading is the count ('1 room'), room cards have a menu with Edit, and a bundle is titled by its rooms", async () => {
    const base = sub();
    mountLive({
      ...base,
      rooms: [
        { ...base.rooms[0]!, id: "room-a", name: "Room 4", monthlyRent: 1100 },
        { ...base.rooms[0]!, id: "room-b", name: "Room 5", monthlyRent: 1200 },
      ],
      bundles: [{ id: "b1", label: "Two or more rooms", price: "2200", strikethrough: "", promo: "", roomsLine: "", includedRoomIds: ["room-a", "room-b"] }],
    } as unknown as typeof base);
    go("pricing");
    expect(stepHeadingText()).toBe("2 rooms");
    const rooms = cards("pricing");
    expect(rooms).toHaveLength(2);
    const items = await openMenu(rooms[0]!.querySelector("[data-attr='listing-v2-pricing-room-menu']")!);
    expect(items.map((item) => item.textContent)).toEqual(["Edit"]);
    fireEvent.click(items[0]!);
    expect(rooms[0]!.querySelector("[data-attr='listing-v2-pricing-format-long']") ?? q("[data-attr='listing-v2-pricing-format-long']")).not.toBeNull();
    const bundle = cards("bundle")[0]!;
    expect(bundle.querySelector("b")!.textContent).toBe("Room 4 + Room 5");
    expect(bundle.textContent).not.toContain("Two or more rooms");
  });

  it("a whole place reads 'Whole place' in the heading", () => {
    const base = sub();
    mountLive({ ...base, listingPlaceCategoryId: "entire_home", entireHomeMonthlyRent: 3200 } as unknown as typeof base);
    go("pricing");
    expect(stepHeadingText()).toBe("Whole place");
  });

  it("by the room: one card per room with its rent on the right", () => {
    mountLive();
    go("pricing");
    const list = cards("pricing");
    expect(list).toHaveLength(1);
    expect(list[0]!.textContent).toContain("Room A");
    expect(list[0]!.textContent).toMatch(/\$1,100/);
    expect(q("[data-attr='listing-v2-pricing-edit']")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("an open room shows two sections, Long-term and Short-term, with every field; editing writes the workspace's fields", () => {
    const live = mountLive();
    go("pricing");
    openCard(cards("pricing")[0]!);
    const long = q("[data-attr='listing-v2-pricing-format-long']")!;
    const short = q("[data-attr='listing-v2-pricing-format-short']")!;
    expect(long.textContent).toContain("Long-term");
    expect(short.textContent).toContain("Short-term");
    for (const label of ["Rent /mo", "Utilities /mo", "Deposit", "Lease fee", "Application fee", "Move-in fee"]) {
      expect(long.textContent, label).toContain(label);
    }
    for (const label of ["Nightly rate", "Deposit", "Lease fee", "Application fee", "Move-in fee"]) {
      expect(short.textContent, label).toContain(label);
    }
    const rent = long.querySelector("input[aria-label='Rent']") as HTMLInputElement;
    fireEvent.focus(rent);
    fireEvent.change(rent, { target: { value: "1250" } });
    const next = live.latest();
    expect(next.rooms[0]!.monthlyRent).toBe(1250);
    // the same patch the pricing workspace applies: marked as priced on its own
    expect(next.roomPricingMeta?.["room-a"]?.priceSource).toBe("own");
    const nightly = short.querySelector("input[aria-label='Nightly rate']") as HTMLInputElement;
    fireEvent.focus(nightly);
    fireEvent.change(nightly, { target: { value: "45" } });
    expect(live.latest().rooms[0]!.shortTermRent).toBe("45");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a whole place has one 'Whole place' card with the same two sections", () => {
    const base = sub();
    mountLive({ ...base, listingPlaceCategoryId: "entire_home", entireHomeMonthlyRent: 3200 } as unknown as typeof base);
    go("pricing");
    const list = cards("pricing");
    expect(list).toHaveLength(1);
    expect(list[0]!.textContent).toContain("Whole place");
    expect(list[0]!.textContent).toMatch(/\$3,200/);
    openCard(list[0]!);
    expect(q("[data-attr='listing-v2-pricing-format-long']")).not.toBeNull();
    expect(q("[data-attr='listing-v2-pricing-format-short']")).not.toBeNull();
    expect(q("[data-attr='listing-v2-bundles']")).toBeNull();
  });

  it("Bundles: no checkbox; on a by-the-room listing the section is always there, Whole house first, with the round +", () => {
    const live = mountLive();
    go("pricing");
    expect(q("[data-attr='listing-v2-bundles']")).not.toBeNull();
    expect(q("[data-attr='listing-v2-bundles-toggle']")).toBeNull();
    expect(document.body.textContent).not.toContain("Offer room bundles");
    // The first card of the section is the whole house; no custom bundle exists yet.
    const bundleCards = qa("[data-attr='listing-v2-bundles'] .pr9-card");
    expect(bundleCards[0]!.getAttribute("data-attr")).toBe("listing-v2-whole-house-card");
    expect(cards("bundle")).toHaveLength(0);
    fireEvent.click(q("[data-attr='listing-v2-add-bundle-icon']")!);
    expect(live.latest().bundles.length).toBe(1);
    const card = cards("bundle")[0]!;
    expect(card.className).toContain("pr9-card");
    expect(q("[data-attr='listing-v2-bundle-rooms']")).not.toBeNull();
    expect(card.textContent).toContain("Long-term");
    expect(card.textContent).toContain("Short-term");
    // Whole house still comes before the custom bundles.
    expect(qa("[data-attr='listing-v2-bundles'] .pr9-card")[0]!.getAttribute("data-attr")).toBe("listing-v2-whole-house-card");
  });

  it("the Whole house card has its own Offered switch; 'Not offered' is its fact while it is off", () => {
    const live = mountLive();
    go("pricing");
    const whole = q("[data-attr='listing-v2-whole-house-card']")!;
    expect(whole.querySelector(".pr9-facts")!.textContent).toContain("Not offered");
    openCard(whole);
    const offered = q("[data-attr='listing-v2-whole-house-offered']")!;
    fireEvent.click(offered);
    expect(live.latest().entireHomeOffered).toBe(true);
    expect(q("[data-attr='listing-v2-whole-house-card'] .pr9-facts")!.textContent).not.toContain("Not offered");
    fireEvent.click(q("[data-attr='listing-v2-whole-house-offered']")!);
    expect(live.latest().entireHomeOffered).toBe(false);
    expect(q("[data-attr='listing-v2-whole-house-card'] .pr9-facts")!.textContent).toContain("Not offered");
  });

  it("existing bundles show under the Whole house card, with no checkbox to turn them off", () => {
    const base = sub();
    mountLive({
      ...base,
      bundles: [{ id: "b1", label: "Both rooms", price: "2000", strikethrough: "", promo: "", roomsLine: "", includedRoomIds: ["room-a"] }],
    } as unknown as typeof base);
    go("pricing");
    expect(q("[data-attr='listing-v2-bundles-toggle']")).toBeNull();
    expect(cards("bundle")).toHaveLength(1);
    expect(qa("[data-attr='listing-v2-bundles'] .pr9-card")[0]!.getAttribute("data-attr")).toBe("listing-v2-whole-house-card");
  });
});

describe("right-hand preview", () => {
  it("shows the leasing summary on the new steps and keeps the Listing preview", () => {
    mount();
    go("application");
    const summary = document.querySelector("[data-attr='listing-v2-detail-summary']")!.textContent!;
    expect(summary).toMatch(/Applications/);
    expect(summary).toMatch(/Leases/);
    expect(summary).toMatch(/Move-in forms(None yet|0 forms|No forms)/);
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
    expect(document.querySelector("[data-attr='listing-v2-add-movein-icon']")).not.toBeNull();
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
