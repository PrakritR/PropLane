// @vitest-environment jsdom
//
// EVIDENCE HARNESS (portal sweep round 3 — pop-ups are labels and controls).
//
// Renders the real New listing pop-up and captures each state as a full HTML page under
// EVIDENCE_DIR (set by the evidence run) so the screens can be screenshotted with the app's
// own CSS. The assertions are the round's rules: no format chips on the file card, no rail
// captions, no "This will create" checklist, and a wrong file type refused IN PLACE with the
// file named.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { saveDraft, deleteDraft } = vi.hoisted(() => ({ saveDraft: vi.fn(), deleteDraft: vi.fn() }));
vi.mock("@/lib/demo-admin-property-inventory", () => ({
  saveManagerPropertyDraftToServer: saveDraft,
  deleteManagerPropertyDraft: deleteDraft,
  publishManagerPropertyDraftToServer: vi.fn(),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({ submitManagerPendingPropertyToServer: vi.fn(), updateExtraListingFromSubmissionOnServer: vi.fn() }));
vi.mock("@/lib/analytics/track-client", () => ({ track: vi.fn() }));
vi.mock("@/lib/manager-subscription-client", () => ({ loadManagerPaymentWaiverGrantedClient: vi.fn(async () => false) }));

import { CreateWorkspace } from "@/components/portal/listing-wizard-v2/create-workspace";
import type { PropertyImportProperty, PropertyImportUnderstanding } from "@/lib/property-import/types";

const pike: PropertyImportProperty = {
  key: "1-houses-400-pike", name: "400 Pike Street", address: "400 Pike Street", city: "Seattle", state: "WA", zip: "98101",
  propertyType: "house", rentByRoom: true, bedrooms: 4, bathrooms: null, monthlyRent: null, deposit: null,
  rooms: [
    { label: "A", rent: 1050, deposit: 1050, sourceRow: 4 },
    { label: "B", rent: 975, deposit: 975, sourceRow: 5 },
    { label: "C", rent: 925, deposit: 925, sourceRow: 6 },
    { label: "D", rent: 950, deposit: 950, sourceRow: 7 },
  ],
  sourceSheet: "Houses", sourceRows: [4, 5, 6, 7], needsLook: [], confidence: "high",
};
const harvard: PropertyImportProperty = {
  ...pike, key: "2-condos-918-harvard", name: "918 Harvard Ave E", address: "918 Harvard Ave E", zip: "",
  propertyType: "condo", rentByRoom: false, bedrooms: 2, bathrooms: 1, monthlyRent: 2650, deposit: 2650, rooms: [],
  sourceSheet: "Condos", sourceRows: [4], needsLook: ["No ZIP in the file"], confidence: "medium",
};
const understanding: PropertyImportUnderstanding = {
  fileName: "owner-messy.xlsx", sourceKind: "xlsx",
  sheets: [
    { name: "Houses", whatItIs: "One row per room, grouped under each house's address.", used: true },
    { name: "Summary", whatItIs: "Totals only.", used: false },
  ],
  properties: [pike, harvard], summary: ["Rent taken from the Rent column, not Market Rent."], truncatedNote: null, rowsRead: 20,
};

const sheet = () => new File(["x"], "owner-messy.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
const photo = () => new File(["x"], "photo.png", { type: "image/png" });

const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? "";
const captured: { name: string; html: string }[] = [];

function capture(name: string) {
  captured.push({ name, html: document.body.innerHTML });
}

afterAll(() => {
  if (!EVIDENCE_DIR) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  for (const { name, html } of captured) {
    writeFileSync(
      join(EVIDENCE_DIR, `${name}.html`),
      `<!doctype html>
<html lang="en" data-theme="light" class="h-full antialiased">
<head><meta charset="utf-8"><link rel="stylesheet" href="./app.css"></head>
<body class="min-h-full overflow-x-clip bg-background text-foreground">${html}</body>
</html>`,
      "utf8",
    );
  }
});

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
  render(<CreateWorkspace onClose={vi.fn()} onDraftsChanged={vi.fn()} userId="mgr-1" skuTier="pro" propertyCount={0} showToast={vi.fn()} />);
}

describe("round 3 — the create pop-up is labels and controls", () => {
  it("opens with the Start from a file card carrying no format chips, and an uncaptioned step rail", () => {
    mount();
    expect(screen.getByText("Start from a file")).toBeTruthy();
    const header = document.querySelector("[data-attr='listing-v2-header-upload']")!;
    expect(header.textContent).not.toContain(".xlsx");
    capture("r3-create-popup-basics");
  });

  it("refuses a wrong file type in place, naming the file", async () => {
    mount();
    // A manager dragging a photo onto the Start-from-a-file card (the OS dialog filters by accept,
    // a drop does not) is refused on the card itself, with the file named.
    const card = document.querySelector("[data-attr='listing-v2-header-upload']")!;
    fireEvent.drop(card, { dataTransfer: { files: [photo()] } });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("That file type isn't supported: photo.png.");
    capture("r3-create-popup-wrong-file-refusal");
  });

  it("reads a spreadsheet and lists what it found with no 'This will create' checklist", async () => {
    mount();
    const input = document.querySelector<HTMLInputElement>("[data-attr='import-upload-file-input']")!;
    await userEvent.upload(input, sheet());
    await screen.findByText("Found 2 properties");
    await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(2));
    expect(document.body.textContent).not.toMatch(/This will create/i);
    const rail = screen.getByRole("navigation", { name: "Listing sections" });
    expect(rail.textContent).not.toContain("owner-messy.xlsx");
    capture("r3-create-popup-import-found");
  });
});
