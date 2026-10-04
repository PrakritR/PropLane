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

/** A listing that offers both stays (Basics: Stays you offer), so every section of a leasing step is drawn. */
const bothStays = () => ({ ...sub(), shortTermRentalsAllowed: true, allowedLeaseTerms: ["Long-term", "Short-Term Stay"] });

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

  it("the phone step tabs list the new steps", () => {
    mount();
    expect(document.querySelector("[data-attr='workspace-step-picker']")).not.toBeNull();
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
    mountLive(bothStays());
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

  it("the menu is Edit, Duplicate and a red Delete last; Applies to and the default live inside the form", async () => {
    mountLive(bothStays());
    go("application");
    const items = await openMenu(q("[data-attr='listing-v2-application-menu']")!);
    const labels = items.map((item) => item.textContent);
    expect(labels).toEqual(["Edit", "Duplicate", "Delete"]);
    expect(items.at(-1)!.className).toContain("text-red");
  });

  it("the form's first two rows are Applies to and Default for long term; a Both form gets a default toggle for each stay", () => {
    mountLive(bothStays());
    go("application");
    openCard(cards("application")[0]!);
    const editor = q("[data-attr='listing-v2-application-editor']")!;
    const rows = Array.from(editor.querySelectorAll(":scope > div")).map((row) => row.textContent ?? "");
    expect(rows[0]).toContain("Applies to");
    expect(rows[0]).toContain("Long-term residents");
    expect(rows[1]).toContain("Default for long term");
    expect(editor.querySelector("[data-attr='listing-v2-application-default-long']")).not.toBeNull();
    expect(editor.querySelector("[data-attr='listing-v2-application-default-short']")).toBeNull();
    fireEvent.click(editor.querySelector("[data-attr='listing-v2-application-applies-to-row']")!);
    tapOption("Both");
    expect(q("[data-attr='listing-v2-application-default-long']")).not.toBeNull();
    expect(q("[data-attr='listing-v2-application-default-short']")).not.toBeNull();
    expect(document.body.textContent).not.toContain("Default for its section");
  });

  it("opening a card unfolds the editor in place: Needed, fee, lease, questions; Done closes it", () => {
    mountLive(bothStays());
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
    const live = mountLive(bothStays());
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

  it("the fee box is the APPLICATION's own fee: it writes the template, and the rooms follow it until overridden", () => {
    const live = mountLive(bothStays());
    go("application");
    openCard(cards("application")[0]!);
    const fee = q("[data-attr='listing-v2-application-fee']") as HTMLInputElement;
    fireEvent.focus(fee);
    fireEvent.change(fee, { target: { value: "75" } });
    const stored = live.latest();
    expect(readPropertyApplicationTemplates(stored)[0]!.feeCentsOverride).toBe(7500);
    const room = stored.rooms[0]!;
    // The room carries nothing of its own; the resolver (quote, charge, lease) reads the template's fee.
    expect(termFeeText(longTermPrivateArrangementRow(room), "applicationFee", "long").value).toBe("");
    expect(resolvePlacementStandardFees(stored, placementFeeOptionsFor(stored, { room, leaseTerm: "Long-term" })).applicationFee).toBe(75);
    expect((q("[data-attr='listing-v2-application-fee']") as HTMLInputElement).value).toBe("75");
    expect(cards("application")[0]!.querySelector(".pr9-facts")!.textContent).toContain("$75");
    // Pricing shows it as the room's greyed default: an empty box whose placeholder is the application's fee.
    go("pricing");
    openCard(cards("pricing")[0]!);
    const roomBox = qa("[data-attr='arrangement-application-fee-long']")[0] as HTMLInputElement;
    expect(roomBox.value).toBe("");
    expect(roomBox.placeholder).toBe("75");
  });

  it("a room's own application fee is an override for that room only, and Reset returns it to the application's fee", () => {
    const live = mountLive(bothStays());
    go("application");
    openCard(cards("application")[0]!);
    const fee = q("[data-attr='listing-v2-application-fee']") as HTMLInputElement;
    fireEvent.focus(fee);
    fireEvent.change(fee, { target: { value: "75" } });
    go("pricing");
    openCard(cards("pricing")[0]!);
    const roomBox = qa("[data-attr='arrangement-application-fee-long']")[0] as HTMLInputElement;
    fireEvent.focus(roomBox);
    fireEvent.change(roomBox, { target: { value: "90" } });
    const stored = live.latest();
    expect(readPropertyApplicationTemplates(stored)[0]!.feeCentsOverride).toBe(7500);
    expect(longTermPrivateArrangementRow(stored.rooms[0]!).applicationFee).toBe("90");
    expect(resolvePlacementStandardFees(stored, placementFeeOptionsFor(stored, { room: stored.rooms[0], leaseTerm: "Long-term" })).applicationFee).toBe(90);
    // Reset is the clear way back to the default.
    const reset = qa("[data-attr='listing-v2-cell-reset']").find((node) => /application fee/i.test(node.getAttribute("aria-label") ?? ""))!;
    fireEvent.click(reset);
    const cleared = live.latest();
    expect(longTermPrivateArrangementRow(cleared.rooms[0]!).applicationFee ?? "").toBe("");
    expect(resolvePlacementStandardFees(cleared, placementFeeOptionsFor(cleared, { room: cleared.rooms[0], leaseTerm: "Long-term" })).applicationFee).toBe(75);
  });

  it("editing the Short term application's fee writes that application's fee only", () => {
    const live = mountLive(bothStays());
    go("application");
    const shortCard = cards("application").find((card) => /Short-term application/.test(cardName(card)))!;
    openCard(shortCard);
    const fee = q("[data-attr='listing-v2-application-fee']") as HTMLInputElement;
    fireEvent.focus(fee);
    fireEvent.change(fee, { target: { value: "30" } });
    const stored = live.latest();
    const room = stored.rooms[0]!;
    expect(readPropertyApplicationTemplates(stored).find((row) => row.listingSeedKey === "short-term")!.feeCentsOverride).toBe(3000);
    expect(readPropertyApplicationTemplates(stored).find((row) => row.listingSeedKey === "primary")!.feeCentsOverride ?? null).toBeNull();
    expect(resolvePlacementStandardFees(stored, placementFeeOptionsFor(stored, { room, rentalType: "short_term" })).applicationFee).toBe(30);
    expect(room.termPricing?.["Short-Term Stay"]?.applicationFee).toBeUndefined();
    expect(longTermPrivateArrangementRow(room).applicationFee ?? "").toBe("");
  });

  it("a new application starts from the PropLane defaults, and every application card carries Application fee and Promo codes in the modal's order", () => {
    mountLive(bothStays());
    go("application");
    openCard(cards("application")[0]!);
    const editor = q("[data-attr='listing-v2-application-editor']")!;
    const order = ["needed", "lease", "cosigner", "fee", "promo-codes"].map((attr) => editor.querySelector(`[data-attr='listing-v2-application-${attr}']`));
    expect(order.every(Boolean) || order.filter(Boolean).length >= 4).toBe(true);
    expect(editor.textContent).not.toMatch(/Tour order|Used for/);
  });

  it("renaming and editing a question inline land on the template's draft config", () => {
    const live = mountLive(bothStays());
    go("application");
    openCard(cards("application")[0]!);
    const name = screen.getByLabelText("Name for application 1") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Room application" } });
    expect(readPropertyApplicationTemplates(live.latest())[0]!.label).toBe("Room application");
    fireEvent.click(q("[data-attr='listing-v2-application-editor-section-toggle-additional']")!);
    fireEvent.click(q("[data-attr='listing-v2-application-editor-add-question']")!);
    const draft = readPropertyApplicationTemplates(live.latest())[0]!.draftQuestionConfig!;
    expect(draft.applicationConfigMode).toBe("custom");
    expect(draft.customApplicationFields.length).toBe(1);
  });

  it("a duplicate or empty name is not saved", () => {
    const live = mountLive(bothStays());
    go("application");
    openCard(cards("application")[0]!);
    const name = screen.getByLabelText("Name for application 1") as HTMLInputElement;
    const before = readPropertyApplicationTemplates(live.latest()).length ? readPropertyApplicationTemplates(live.latest())[0]!.label : "";
    fireEvent.change(name, { target: { value: "" } });
    expect(screen.getByRole("alert").textContent).toMatch(/Enter a name/);
    if (before) expect(readPropertyApplicationTemplates(live.latest())[0]!.label).toBe(before);
  });

  it("+ offers Build from PropLane standard and Upload a PDF; the first adds one inline, already open, started from the standard", async () => {
    const live = mountLive(bothStays());
    go("application");
    const choices = await openMenu(q("[data-attr='listing-v2-add-application-icon']")!);
    expect(choices.map((item) => item.textContent)).toEqual(["Build from PropLane standard", "Upload a PDF"]);
    fireEvent.click(choices[0]!);
    // "Applies to" is asked FIRST: nothing is made until it is answered.
    expect(q("[data-attr='listing-v2-application-applies-to-ask']")).not.toBeNull();
    expect(headingText()).toBe("3 applications");
    fireEvent.click(q("[data-attr='listing-v2-application-applies-to-create']")!);
    expect(headingText()).toBe("4 applications");
    const created = readPropertyApplicationTemplates(live.latest()).at(-1)!;
    expect(created.appliesTo).toBe("long_term");
    expect(created.listingSeedKey).toBeUndefined();
    expect(created.draftQuestionConfig?.applicationConfigMode).toBe("custom");
    expect(q("[data-attr='listing-v2-application-start-from']")).not.toBeNull();
    expect(q("[data-attr='listing-v2-application-questions']")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a new application answers Applies to first; Short-term residents makes a short-term form linked to the short-term lease", async () => {
    const live = mountLive(bothStays());
    go("application");
    const choices = await openMenu(q("[data-attr='listing-v2-add-application-icon']")!);
    fireEvent.click(choices[0]!);
    fireEvent.click(q("[data-attr='listing-v2-application-applies-to']")!);
    const offered = Array.from(screen.getAllByRole("listbox").at(-1)!.querySelectorAll('[role="option"]')).map((node) => node.textContent);
    expect(offered).toEqual(["Long-term residents", "Short-term residents", "Both"]);
    tapOption("Short-term residents");
    fireEvent.click(q("[data-attr='listing-v2-application-applies-to-create']")!);
    const created = readPropertyApplicationTemplates(live.latest()).at(-1)!;
    expect(created.appliesTo).toBe("short_term");
    expect(created.formVariant).toBe("short_term");
    const shortLease = readPropertyLeaseTemplates(live.latest()).find((row) => row.listingSeedKey === "short-term");
    if (shortLease) expect(created.linkedLeaseTemplateId).toBe(shortLease.id);
    // It lands under the Short term header.
    const shortNames = qa("[data-attr='listing-v2-stay-section-short_term'] [data-attr='listing-v2-application-card'] input").map((input) => (input as HTMLInputElement).value);
    expect(shortNames).toContain(created.label);
  });

  it("groups applications under Long term and Short term only (no Both section), and hides a stay the listing does not offer without deleting", () => {
    const live = mountLive(bothStays());
    go("application");
    expect(["long_term", "short_term", "both"].map((key) => q(`[data-attr='listing-v2-stay-section-${key}']`) !== null)).toEqual([true, true, false]);
    const stored = readPropertyApplicationTemplates(live.latest()).length;
    cleanup();
    const longOnly = mountLive(sub());
    go("application");
    expect(q("[data-attr='listing-v2-stay-section-short_term']")).toBeNull();
    expect(q("[data-attr='listing-v2-stay-section-long_term']")).not.toBeNull();
    // Hidden, not deleted: the stored list is the same size.
    expect(readPropertyApplicationTemplates(longOnly.latest()).length === stored || readPropertyApplicationTemplates(longOnly.latest()).length === 0).toBe(true);
  });

  it("the form's Applies to moves an application between sections and its default toggle sets the default, shown as a plain ★ fact", () => {
    const live = mountLive(bothStays());
    go("application");
    const longCards = () => qa("[data-attr='listing-v2-stay-section-long_term'] [data-attr='listing-v2-application-card']");
    // Move the co-signer-free first application to Short term, so Short term holds two.
    openCard(longCards()[0]!);
    fireEvent.click(q("[data-attr='listing-v2-application-applies-to-row']")!);
    tapOption("Short-term residents");
    const stored = readPropertyApplicationTemplates(live.latest());
    expect(stored[0]!.appliesTo).toBe("short_term");
    const shortCards = qa("[data-attr='listing-v2-stay-section-short_term'] [data-attr='listing-v2-application-card']");
    expect(shortCards).toHaveLength(2);
    const starred = shortCards.filter((card) => card.textContent?.includes("★ Default"));
    expect(starred).toHaveLength(1);
    // Make the OTHER one the default.
    const other = shortCards.find((card) => !card.textContent?.includes("★ Default"))!;
    openCard(other);
    fireEvent.click(other.querySelector("[data-attr='listing-v2-application-default-short']")!);
    const after = readPropertyApplicationTemplates(live.latest());
    expect(after.filter((row) => row.defaultFor?.includes("short_term"))).toHaveLength(1);
    const defaultRow = after.find((row) => row.defaultFor?.includes("short_term"))!;
    const nowShort = qa("[data-attr='listing-v2-stay-section-short_term'] [data-attr='listing-v2-application-card']");
    expect(nowShort.find((card) => card.textContent?.includes("★ Default"))!.querySelector("input")!.value).toBe(defaultRow.label);
  });

  it("Duplicate copies a card and opens the copy", async () => {
    const live = mountLive(bothStays());
    go("application");
    const items = await openMenu(q("[data-attr='listing-v2-application-menu']")!);
    fireEvent.click(items.find((item) => item.textContent === "Duplicate")!);
    expect(readPropertyApplicationTemplates(live.latest()).some((row) => /copy$/.test(row.label))).toBe(true);
    expect(headingText()).toBe("4 applications");
  });

  it("Delete (after a tap to confirm) removes a card", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const live = mountLive(bothStays());
    go("application");
    const items = await openMenu(q("[data-attr='listing-v2-application-menu']")!);
    fireEvent.click(items.find((item) => item.textContent === "Delete")!);
    await waitFor(() => expect(readPropertyApplicationTemplates(live.latest()).length).toBe(2));
    expect(headingText()).toBe("2 applications");
  });

  it("'Application before a tour' is one settings row under the cards: Not needed by default, a pick saves to the workspace", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    mountLive(bothStays());
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
    mountLive(bothStays());
    go("application");
    await waitFor(() => expect(q("[data-attr='listing-v2-application-before-tour-select']")!.textContent).toContain("Required"));
  });
});

describe("Lease step", () => {
  it("is the Rooms pattern: a count heading with the round +, a card per lease with a menu and its facts", () => {
    mountLive(subWithLeases());
    go("lease");
    // The heading counts the leases the property has; a default it lacks is a Quick add action, not a card.
    expect(headingText()).toBe("2 leases");
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
    expect(headingText()).toBe("3 leases");
    expect(q("[data-attr='listing-v2-lease-start-from']")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a PropLane default the property lacks is a Quick add action under the list, never a placeholder card", () => {
    const live = mountLive();
    go("lease");
    expect(qa("[data-attr='listing-v2-lease-default-card']")).toHaveLength(0);
    expect(qa("[data-attr='listing-v2-lease-card']")).toHaveLength(0);
    expect(headingText()).toBe("0 leases");
    const row = q("[data-attr='listing-v2-lease-quick-add']")!;
    expect(row.textContent).toContain("Quick add");
    const actions = Array.from(row.querySelectorAll("button")).map((button) => button.textContent);
    expect(actions).toEqual(["Long-term lease", "Short-term lease"]);
    fireEvent.click(row.querySelector("[data-attr='listing-v2-lease-quick-add-primary']")!);
    expect(readPropertyLeaseTemplates(live.latest()).map((lease) => lease.label)).toEqual(["Long-term lease"]);
    // The re-added default is a card now and leaves the Quick add row.
    expect(headingText()).toBe("1 lease");
    expect(Array.from(q("[data-attr='listing-v2-lease-quick-add']")!.querySelectorAll("button")).map((b) => b.textContent)).toEqual(["Short-term lease"]);
  });

  it("every lease card, a PropLane default included, has Edit, Duplicate and a red Delete last; deleting a default brings back its Quick add", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const withThree = subWithLeases();
    const live = mountLive({
      ...withThree,
      propertyLeaseTemplates: [...withThree.propertyLeaseTemplates!, lease("l3", "Parking addendum", { kind: "custom" })],
    } as never);
    go("lease");
    const defaultCard = cards("lease")[0]!;
    const items = await openMenu(defaultCard.querySelector("[data-attr='listing-v2-lease-menu']")!);
    expect(items.map((item) => item.textContent)).toEqual(["Edit", "Duplicate", "Delete"]);
    fireEvent.click(items.at(-1)!);
    await waitFor(() => expect(readPropertyLeaseTemplates(live.latest()).some((lease) => lease.id === "l1")).toBe(false));
    expect(q("[data-attr='listing-v2-lease-quick-add-primary']")).not.toBeNull();
  });

  it("an open lease sets its own Lease fee (on the lease, not the room) and offers Promo codes", () => {
    const live = mountLive(subWithLeases());
    go("lease");
    openCard(cards("lease")[0]!);
    const fee = q("[data-attr='listing-v2-lease-fee']") as HTMLInputElement;
    fireEvent.focus(fee);
    fireEvent.change(fee, { target: { value: "250" } });
    expect(readPropertyLeaseTemplates(live.latest()).find((row) => row.id === "l1")!.leaseFeeCents).toBe(25000);
    // The room carries no value of its own: it follows the lease.
    expect(longTermPrivateArrangementRow(live.latest().rooms[0]!).leaseFee ?? "").toBe("");
    expect(resolvePlacementStandardFees(live.latest(), placementFeeOptionsFor(live.latest(), { room: live.latest().rooms[0], leaseTerm: "Long-term" })).leaseFee).toBe(250);
    expect(q("[data-attr='listing-v2-lease-promo-codes']")).not.toBeNull();
    fireEvent.change(q("[data-attr='listing-v2-lease-fee']")!, { target: { value: "" } });
    expect(readPropertyLeaseTemplates(live.latest()).find((row) => row.id === "l1")!.leaseFeeCents).toBeNull();
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
  // A desktop pointer: the select is a popover here (a phone gets the shared bottom sheet).
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("pointer: fine"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }));
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
    fireEvent.click(qa("[data-attr^='move-in-questions-editor-section-toggle-'][aria-expanded='false']")[0]!);
    fireEvent.click(qa("[data-attr='move-in-questions-editor-add-question']")[0]!);
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

  // One section per stay the listing offers, stacked (no tabs): Long term, Short term, never a Both.
  const tabLabels = (scope: ParentNode = document) =>
    Array.from(scope.querySelectorAll("[data-attr='listing-v2-pricing-options'] > section")).map((section) => section.getAttribute("aria-label"));
  const shortStays = () => ({ ...sub(), shortTermRentalsAllowed: true, allowedLeaseTerms: ["Long-term", "Short-Term Stay"] });

  it("an open room draws one independent section per stay the property offers, each with only its own fields", () => {
    const live = mountLive(shortStays() as never);
    go("pricing");
    openCard(cards("pricing")[0]!);
    expect(tabLabels()).toEqual(["Long term", "Short term"]);
    // No tab strip inside Pricing (the wizard's own step tabs are elsewhere on the page).
    expect(q("[data-attr='listing-v2-pricing-options'] [role='tab']")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Both/);
    const long = q("[data-attr='listing-v2-pricing-format-long']")!;
    for (const label of ["Rent /mo", "Utilities /mo", "Deposit", "Lease fee", "Application fee", "Move-in fee"]) {
      expect(long.textContent, label).toContain(label);
    }
    expect(long.textContent).not.toContain("Nightly rate");
    const rent = long.querySelector("input[aria-label='Rent']") as HTMLInputElement;
    fireEvent.focus(rent);
    fireEvent.change(rent, { target: { value: "1250" } });
    const next = live.latest();
    expect(next.rooms[0]!.monthlyRent).toBe(1250);
    // the same patch the pricing workspace applies: marked as priced on its own
    expect(next.roomPricingMeta?.["room-a"]?.priceSource).toBe("own");
    // The Short term section is drawn at the same time, with its own fields.
    const short = q("[data-attr='listing-v2-pricing-format-short']")!;
    for (const label of ["Nightly rate", "Deposit", "Lease fee", "Application fee", "Move-in fee"]) {
      expect(short.textContent, label).toContain(label);
    }
    expect(short.textContent).not.toContain("Rent /mo");
    const nightly = short.querySelector("input[aria-label='Nightly rate']") as HTMLInputElement;
    fireEvent.focus(nightly);
    fireEvent.change(nightly, { target: { value: "45" } });
    expect(live.latest().rooms[0]!.shortTermRent).toBe("45");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a property that offers only long term has one section (Short term is not drawn); Month-to-month is a Long term row, never a section", () => {
    mountLive();
    go("pricing");
    openCard(cards("pricing")[0]!);
    expect(tabLabels()).toEqual(["Long term"]);
    expect(q("[data-attr='listing-v2-pricing-format-month-to-month']")).toBeNull();
    cleanup();
    const withM2m = {
      ...sub(),
      allowedLeaseTerms: ["Long-term", "Month-to-Month"],
      propertyLeaseTemplates: [lease("l1", "Long-term lease", { listingSeedKey: "primary", applicationLeaseTerms: ["Long-term", "Month-to-Month"] })],
    };
    mountLive(withM2m as never);
    go("pricing");
    openCard(cards("pricing")[0]!);
    // Only two sections ever exist: month-to-month is a Long term row, not a section of its own.
    expect(tabLabels()).toEqual(["Long term"]);
    expect(screen.queryAllByText("Month-to-month surcharge").length).toBeGreaterThan(0);
  });

  it("a room's Application fee and Lease fee default from the application and the lease, per tab", () => {
    const base = shortStays();
    const tuned = {
      ...base,
      propertyApplicationTemplates: [
        { id: "a-long", kind: "long-term", formVariant: "standard", listingSeedKey: "primary", label: "Long-term application", feeCentsOverride: 4500, linkedLeaseTemplateId: "l1", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
        { id: "a-short", kind: "short-term", formVariant: "short_term", listingSeedKey: "short-term", label: "Short-term application", feeCentsOverride: 2500, linkedLeaseTemplateId: "l2", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
      ],
      propertyApplicationTemplatesExplicit: true,
      propertyLeaseTemplates: [
        lease("l1", "Long-term lease", { listingSeedKey: "primary", applicationLeaseTerms: ["Long-term"], leaseFeeCents: 20000 }),
        lease("l2", "Short-term lease", { kind: "short-term", listingSeedKey: "short-term", applicationLeaseTerms: ["Short-Term Stay"], leaseFeeCents: 9000 }),
      ],
    };
    mountLive(tuned as never);
    go("pricing");
    openCard(cards("pricing")[0]!);
    const box = (attr: string) => q(`[data-attr='${attr}']`) as HTMLInputElement;
    expect([box("arrangement-application-fee-long").placeholder, box("arrangement-lease-fee-long").placeholder]).toEqual(["45", "200"]);
    expect([box("arrangement-application-fee-long").value, box("arrangement-lease-fee-long").value]).toEqual(["", ""]);
    expect([box("arrangement-application-fee-short").placeholder, box("arrangement-lease-fee-short").placeholder]).toEqual(["25", "90"]);
  });

  it("a whole place has one 'Whole place' card with the same option tabs", () => {
    const base = shortStays();
    mountLive({ ...base, listingPlaceCategoryId: "entire_home", entireHomeMonthlyRent: 3200 } as unknown as typeof base);
    go("pricing");
    const list = cards("pricing");
    expect(list).toHaveLength(1);
    expect(list[0]!.textContent).toContain("Whole place");
    expect(list[0]!.textContent).toMatch(/\$3,200/);
    openCard(list[0]!);
    expect(tabLabels()).toEqual(["Long term", "Short term"]);
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
    // addBundle opens the new card, so its option tabs are already drawn.
    expect(tabLabels(card)).toEqual(["Long term"]);
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

describe("Stays you offer and the Long term / Short term / Both sections", () => {
  const stayCard = (stay: string) => q(`[data-attr='listing-v2-stay-${stay}']`)!;

  it("Basics offers Long term and Short term as two checkbox cards; Long term is on, Short term is off", () => {
    mountLive();
    expect(stayCard("long-term").getAttribute("aria-checked")).toBe("true");
    expect(stayCard("short-term").getAttribute("aria-checked")).toBe("false");
  });

  it("ticking Short term writes the EXISTING allowedLeaseTerms and shortTermRentalsAllowed", () => {
    const live = mountLive();
    fireEvent.click(stayCard("short-term"));
    expect(live.latest().shortTermRentalsAllowed).toBe(true);
    expect(resolveAllowedLeaseTerms(live.latest())).toEqual(["Long-term", "Short-Term Stay"]);
    expect(stayCard("short-term").getAttribute("aria-checked")).toBe("true");
    // Either or both: Long term off leaves Short term alone.
    fireEvent.click(stayCard("long-term"));
    expect(resolveAllowedLeaseTerms(live.latest())).toEqual(["Short-Term Stay"]);
  });

  it("refuses to turn the last stay off", () => {
    const live = mountLive();
    const before = live.latest();
    fireEvent.click(stayCard("long-term"));
    expect(live.latest()).toBe(before);
    expect(stayCard("long-term").getAttribute("aria-checked")).toBe("true");
    expect(q("[data-attr='listing-v2-stay-min-one']")!.textContent).toMatch(/at least one/i);
  });

  it("the Pricing step no longer carries the Lease terms pick (Basics is the only place)", () => {
    mountLive(bothStays());
    go("pricing");
    expect(q("[data-attr='listing-v2-lease-terms']")).toBeNull();
    expect(q("[data-attr='lease-type']")).toBeNull();
  });

  it("Lease rows sit under their stay by kind, and a stay the listing does not offer is hidden, not deleted", () => {
    const base = bothStays();
    const withLeases = {
      ...base,
      propertyLeaseTemplates: [
        lease("l1", "Long-term lease", { listingSeedKey: "primary", applicationLeaseTerms: ["Long-term"] }),
        lease("l2", "Short-term lease", { kind: "short-term", listingSeedKey: "short-term", applicationLeaseTerms: ["Short-Term Stay"] }),
        lease("l3", "Time based", { kind: "time-based" }),
      ],
    };
    const names = (section: string) =>
      qa(`[data-attr='listing-v2-stay-section-${section}'] [data-attr='listing-v2-lease-card'] input`).map((input) => (input as HTMLInputElement).value);
    const live = mountLive(withLeases as never);
    go("lease");
    expect(names("long_term")).toEqual(["Long-term lease", "Time based"]);
    expect(names("short_term")).toEqual(["Short-term lease"]);
    expect(q("[data-attr='listing-v2-stay-section-both']")).toBeNull();
    cleanup();
    const longOnly = mountLive({ ...withLeases, shortTermRentalsAllowed: false, allowedLeaseTerms: ["Long-term"] } as never);
    go("lease");
    expect(q("[data-attr='listing-v2-stay-section-short_term']")).toBeNull();
    expect(names("long_term")).toEqual(["Long-term lease", "Time based"]);
    expect(readPropertyLeaseTemplates(longOnly.latest()).length).toBe(readPropertyLeaseTemplates(live.latest()).length);
  });

  it("Move-in forms sit under their lease type: All is listed in each section", () => {
    const forms = [
      { ...structuredClone(MOVE_IN_FORM_STARTERS[0]!), id: "mi-all", name: "Everyone", trigger: "manual" as const },
      { ...structuredClone(MOVE_IN_FORM_STARTERS[1] ?? MOVE_IN_FORM_STARTERS[0]!), id: "mi-long", name: "Long only", leaseType: "long-term" as const, trigger: "manual" as const },
      { ...structuredClone(MOVE_IN_FORM_STARTERS[1] ?? MOVE_IN_FORM_STARTERS[0]!), id: "mi-short", name: "Short only", leaseType: "short-term" as const, trigger: "manual" as const },
    ];
    mountLive({ ...bothStays(), moveInFormTemplates: forms } as never);
    go("movein");
    const names = (section: string) =>
      qa(`[data-attr='listing-v2-stay-section-${section}'] [data-attr='listing-v2-movein-card'] input`).map((input) => (input as HTMLInputElement).value);
    // "All" lease types is the same form listed in each section; there is no Both section.
    expect(names("long_term")).toEqual(["Everyone", "Long only"]);
    expect(names("short_term")).toEqual(["Everyone", "Short only"]);
    expect(q("[data-attr='listing-v2-stay-section-both']")).toBeNull();
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
