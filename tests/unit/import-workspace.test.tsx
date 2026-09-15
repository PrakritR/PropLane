// @vitest-environment jsdom
//
// Import properties: a file is read on the server, every property it found
// becomes an ordinary listing draft on the spot, the Found list is the table
// of contents, and "Not a property" / "Merge into…" keep the drafts honest.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { saveDraft, deleteDraft } = vi.hoisted(() => ({ saveDraft: vi.fn(), deleteDraft: vi.fn() }));
vi.mock("@/lib/demo-admin-property-inventory", () => ({
  saveManagerPropertyDraftToServer: saveDraft,
  deleteManagerPropertyDraft: deleteDraft,
  publishManagerPropertyDraftToServer: vi.fn(),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({ submitManagerPendingPropertyToServer: vi.fn(), updateExtraListingFromSubmissionOnServer: vi.fn() }));
vi.mock("@/lib/analytics/track-client", () => ({ track: vi.fn() }));
vi.mock("@/lib/manager-subscription-client", () => ({ loadManagerPaymentWaiverGrantedClient: vi.fn(async () => false) }));

import { ImportWorkspace, mergeImportedProperties } from "@/components/portal/listing-wizard-v2/import-workspace";
import type { PropertyImportProperty, PropertyImportUnderstanding } from "@/lib/property-import/types";

const pike: PropertyImportProperty = {
  key: "1-houses-400-pike",
  name: "400 Pike Street",
  address: "400 Pike Street",
  city: "Seattle",
  state: "WA",
  zip: "98101",
  propertyType: "house",
  rentByRoom: true,
  bedrooms: 4,
  bathrooms: null,
  monthlyRent: null,
  deposit: null,
  rooms: [
    { label: "A", rent: 1050, deposit: 1050, sourceRow: 4 },
    { label: "B", rent: 975, deposit: 975, sourceRow: 5 },
    { label: "C", rent: 925, deposit: 925, sourceRow: 6 },
    { label: "D", rent: 950, deposit: 950, sourceRow: 7 },
  ],
  sourceSheet: "Houses",
  sourceRows: [4, 5, 6, 7],
  needsLook: [],
  confidence: "high",
};
const harvard: PropertyImportProperty = {
  ...pike,
  key: "2-condos-918-harvard",
  name: "918 Harvard Ave E",
  address: "918 Harvard Ave E",
  zip: "",
  propertyType: "condo",
  rentByRoom: false,
  bedrooms: 2,
  bathrooms: 1,
  monthlyRent: 2650,
  deposit: 2650,
  rooms: [],
  sourceSheet: "Condos",
  sourceRows: [4],
  needsLook: ["No ZIP in the file"],
  confidence: "medium",
};
const understanding: PropertyImportUnderstanding = {
  fileName: "owner-messy.xlsx",
  sourceKind: "xlsx",
  sheets: [
    { name: "Houses", whatItIs: "One row per room, grouped under each house's address.", used: true },
    { name: "Summary", whatItIs: "Totals only.", used: false },
  ],
  properties: [pike, harvard],
  summary: ["Rent taken from the Rent column, not Market Rent."],
  truncatedNote: null,
  rowsRead: 20,
};

function file(name = "owner-messy.xlsx") {
  return new File(["x"], name, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

let ids = 0;
beforeEach(() => {
  ids = 0;
  saveDraft.mockReset().mockImplementation(async () => `mgr-draft-${++ids}`);
  deleteDraft.mockReset().mockResolvedValue(true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, understanding }), { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount() {
  const onDraftsChanged = vi.fn();
  render(<ImportWorkspace onClose={vi.fn()} onDraftsChanged={onDraftsChanged} userId="mgr-1" skuTier="pro" propertyCount={0} showToast={vi.fn()} />);
  return { onDraftsChanged };
}

async function uploadAndWait() {
  const input = document.querySelector<HTMLInputElement>("[data-attr='import-upload-file-input']")!;
  await userEvent.upload(input, file());
  await screen.findByText("Found 2 properties");
  await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(2));
}

describe("ImportWorkspace", () => {
  it("opens on Upload as step 1 of 7 with the listing steps on the rail and Continue off", () => {
    mount();
    expect(screen.getByText("Upload your spreadsheet")).toBeInTheDocument();
    const rail = screen.getByRole("navigation", { name: "Listing sections" });
    expect(rail.textContent).toContain("Upload");
    expect(rail.textContent).toContain("Basics");
    expect(rail.textContent).toContain("Review");
    expect(screen.getByText("Step 1 of 7")).toBeInTheDocument();
    expect(document.querySelector("[data-attr='import-upload-continue']")).toBeDisabled();
  });

  it("reads the file on the server, saves one draft per property, and lists them with rows cited", async () => {
    const { onDraftsChanged } = mount();
    await uploadAndWait();
    expect(fetch).toHaveBeenCalledWith("/api/portal/property-import/read", expect.objectContaining({ method: "POST" }));
    const list = document.querySelector("[data-attr='import-found-list']")!;
    const rows = list.querySelectorAll("[data-attr='import-found-row']");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("400 Pike Street, 98101");
    expect(rows[0]!.textContent).toContain("By the room · 4 rooms · $3,900/mo · rows 4–7");
    expect(rows[0]!.textContent).toContain("Ready");
    expect(rows[1]!.textContent).toContain("1 to check");
    // Each draft was written through the ordinary save path, as a NEW row.
    for (const call of saveDraft.mock.calls) {
      expect(call[1]).toBe("mgr-1");
      expect(call[2]).toMatchObject({ existingDraftId: null, allowIdUpgrade: true });
    }
    expect(saveDraft.mock.calls[0]![0].address).toBe("400 Pike Street");
    expect(saveDraft.mock.calls[0]![0].rooms.map((r: { monthlyRent: number }) => r.monthlyRent)).toEqual([1050, 975, 925, 950]);
    expect(onDraftsChanged).toHaveBeenCalled();
    expect(screen.getByText("Saved · 2 drafts")).toBeInTheDocument();
    expect(document.querySelector("[data-attr='import-understood']")!.textContent).toContain("Houses");
    expect(document.querySelector("[data-attr='import-understood']")!.textContent).toContain("Rent taken from the Rent column");
    expect(document.querySelector("[data-attr='import-upload-continue']")).not.toBeDisabled();
    expect(document.querySelector("[data-attr='import-property-switcher']")!.textContent).toContain("1 of 2");
  });

  it("opens a property in the Add property editor with Upload behind it on the rail, and the switcher in the header", async () => {
    mount();
    await uploadAndWait();
    fireEvent.click(document.querySelectorAll("[data-attr='import-found-open']")[1]!);
    await screen.findByText("Basics", { selector: "[data-attr='listing-v2-rail-basics'] *" });
    expect(document.querySelector("[data-attr='listing-v2-rail-upload']")).not.toBeNull();
    expect(document.querySelector("[data-attr='import-property-switcher']")!.textContent).toContain("2 of 2");
    expect(document.querySelector("[data-attr='import-property-switcher']")!.textContent).toContain("918 Harvard Ave E");
    // The file's values are on the form, marked as imported.
    expect(screen.getAllByText("Imported").length).toBeGreaterThan(0);
    // Back on Basics returns to the Found list.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByText("Found 2 properties");
  });

  it("Not a property removes the row and deletes its draft", async () => {
    mount();
    await uploadAndWait();
    await userEvent.click(document.querySelectorAll("[data-attr='import-found-actions']")[1]!);
    await userEvent.click(await screen.findByText("Not a property"));
    await waitFor(() => expect(deleteDraft).toHaveBeenCalledWith("mgr-draft-2", "mgr-1"));
    expect(document.querySelectorAll("[data-attr='import-found-row']")).toHaveLength(1);
    expect(screen.getByText("Found 1 property")).toBeInTheDocument();
  });

  it("Merge into… folds the rooms together, deletes the folded draft and re-saves the target", async () => {
    mount();
    await uploadAndWait();
    await userEvent.click(document.querySelectorAll("[data-attr='import-found-actions']")[1]!);
    await userEvent.click(await screen.findByText("Merge into 400 Pike Street"));
    await waitFor(() => expect(deleteDraft).toHaveBeenCalledWith("mgr-draft-2", "mgr-1"));
    await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(3));
    expect(saveDraft.mock.calls[2]![2]).toMatchObject({ existingDraftId: "mgr-draft-1" });
    expect(document.querySelectorAll("[data-attr='import-found-row']")).toHaveLength(1);
  });

  it("tells the manager, in the server's words, when a draft could not be written", async () => {
    saveDraft.mockImplementation(async (_sub: unknown, _uid: string, opts: { onError?: (m: string) => void }) => {
      opts.onError?.("This workspace has reached 10 property records, including drafts.");
      return null;
    });
    const showToast = vi.fn();
    render(<ImportWorkspace onClose={vi.fn()} userId="mgr-1" skuTier="pro" propertyCount={10} showToast={showToast} />);
    await userEvent.upload(document.querySelector<HTMLInputElement>("[data-attr='import-upload-file-input']")!, file());
    await screen.findByText("Found 2 properties");
    await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("Not saved")).toBeInTheDocument());
    const rows = document.querySelectorAll("[data-attr='import-found-row']");
    expect(rows[0]!.textContent).toContain("Not saved — This workspace has reached 10 property records, including drafts");
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("2 of 2 could not be saved as a draft — This workspace has reached 10 property records, including drafts"));
  });

  it("shows the server's refusal and offers the hint box", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "PropLane couldn't make sense of that file.", code: "unreadable" }), { status: 422 })));
    mount();
    await userEvent.upload(document.querySelector<HTMLInputElement>("[data-attr='import-upload-file-input']")!, file());
    await screen.findByText("Couldn't read this file");
    expect(screen.getByRole("alert").textContent).toContain("couldn't make sense");
    expect(document.querySelector("[data-attr='import-upload-hint']")).not.toBeNull();
    expect(saveDraft).not.toHaveBeenCalled();
  });
});

describe("mergeImportedProperties", () => {
  it("appends rooms, keeps the target's identity and unions the cited rows", () => {
    const merged = mergeImportedProperties(harvard, pike);
    expect(merged.address).toBe("400 Pike Street");
    expect(merged.rooms).toHaveLength(4);
    expect(merged.sourceRows).toEqual([4, 5, 6, 7]);
    expect(merged.needsLook).toEqual(["No ZIP in the file"]);
    expect(merged.confidence).toBe("medium");
  });
});
