/** @vitest-environment jsdom */
//
// EVIDENCE HARNESS — "commit the room form's draft on every exit but Cancel" (Oct 17).
//
// Add room opens the room form on an UNSAVED copy of the listing holding the new blank room.
// Reaching for "+ Add bathroom" from inside that form navigates to the Bathrooms tab — and used
// to throw the half-filled room away. Every exit the form offers except Cancel now writes first
// (`docs/agents/property-drafts.md`: closing the wizard saves).
//
// This drives the REAL `PropertyHouseDetailsListPanel` through a manager's actual clicks against a
// stateful listing (the persist callback applies the payload, as the page does) and dumps each
// step as a full HTML page under EVIDENCE_DIR, for
// `tests/browser/ui-sweep-1016/add-room.spec.ts` to paint with the app's own Tailwind build.
//
//   EVIDENCE_DIR=<dir> npx vitest run tests/unit/evidence-add-room-commit-1017.test.tsx
//   EVIDENCE_DIR=<dir> npx playwright test --config tests/browser/ui-sweep-1016.config.ts
import { useState } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? "";
const captured: { name: string; caption: string; html: string }[] = [];

function capture(name: string, caption: string) {
  captured.push({ name, caption, html: document.body.innerHTML });
}

afterAll(() => {
  if (!EVIDENCE_DIR) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  for (const { name, caption, html } of captured) {
    writeFileSync(
      join(EVIDENCE_DIR, `${name}.html`),
      `<!doctype html><html lang="en" data-theme="light" class="h-full antialiased">
<head><meta charset="utf-8"><link rel="stylesheet" href="./app.css"></head>
<body class="min-h-full overflow-x-clip bg-background text-foreground">
<p style="position:relative;z-index:2147483647;font:600 13px/1.5 system-ui;color:#475569;margin:12px 16px;max-width:1100px;white-space:pre-line">${caption}</p>
${html}</body></html>`,
      "utf8",
    );
  }
});

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/properties/all/p1",
  useRouter: () => ({ push: () => {} }),
}));

import { PropertyHouseDetailsListPanel } from "@/components/portal/property-house-details-list-panel";
import {
  createDefaultListingSubmission,
  emptyBathroom,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { normalizeHouseInfo } from "@/lib/house-info";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) })));
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function houseWithOneRoomAndOneBath(): ManagerListingSubmissionV1 {
  const sub = createDefaultListingSubmission();
  sub.rooms = [{ ...sub.rooms[0]!, id: "room-a", name: "Room A", floor: "2nd floor" }];
  sub.bathrooms = [{ ...emptyBathroom(0), id: "bath-1", name: "Bath 1", location: "2nd floor" }];
  return sub;
}

/** The page, not a prop: the persisted listing is what the panel re-renders from. */
function HouseDetailsPage({ onWrite }: { onWrite?: (sub: ManagerListingSubmissionV1) => void }) {
  const [sub, setSub] = useState(houseWithOneRoomAndOneBath);
  return (
    <div className="mx-auto max-w-[1100px] p-4">
      <PropertyHouseDetailsListPanel
        propertyId="p1"
        sub={sub}
        houseInfo={normalizeHouseInfo(undefined)}
        managerNotes=""
        managerUserId="mgr-1"
        onPersist={(payload) => {
          setSub(payload.sub as ManagerListingSubmissionV1);
          onWrite?.(payload.sub as ManagerListingSubmissionV1);
          return true;
        }}
      />
    </div>
  );
}

const roomRowNames = () =>
  Array.from(document.querySelectorAll(".portal-property-row")).map(
    (row) => row.querySelector("p")?.textContent?.trim() ?? "",
  );

const addRoomNamed = (name: string) => {
  fireEvent.click(screen.getByRole("button", { name: "Add room" }));
  fireEvent.change(screen.getByLabelText("Room name"), { target: { value: name } });
};
const roomEditorOpen = () =>
  Boolean(document.querySelector('[data-attr="property-house-details-room-editor"]'));
const goToTab = (label: string) =>
  fireEvent.click(
    Array.from(document.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").replace(/\d+$/, "").trim().startsWith(label),
    )!,
  );

describe("Add room: every exit but Cancel keeps the room", () => {
  it("writes the half-filled room when + Add bathroom navigates away", () => {
    const written: ManagerListingSubmissionV1[] = [];
    render(<HouseDetailsPage onWrite={(sub) => written.push(sub)} />);

    expect(screen.getByText("Room A")).toBeTruthy();
    capture(
      "13-add-room-before",
      "Before: the house has one room. The manager is about to add a second one — and, from inside that new room's form, reach for “+ Add bathroom”.",
    );

    addRoomNamed("Attic");
    expect(roomEditorOpen()).toBe(true);
    capture(
      "14-add-room-form-unsaved",
      "Add room opens the form on an UNSAVED copy of the listing holding the new room. “Attic” is typed but nothing is written yet — the bathroom dropdown's “+ Add bathroom” is the exit that used to lose it.",
    );

    // The bathroom picker's "+ Add bathroom": it mints the row into the draft and navigates to the
    // Bathrooms tab in the SAME handler.
    const dropdown = screen.getByRole("button", { name: "Bathroom for Attic" });
    fireEvent.click(dropdown);
    const option = document
      .getElementById(dropdown.getAttribute("aria-controls")!)!
      .querySelector('[data-field-select-option-value="__add_bathroom__"]')!;
    fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });

    // The navigation happened, the form closed, and the write carried BOTH the new room and the
    // bathroom that same click minted.
    expect(roomEditorOpen()).toBe(false);
    expect(window.localStorage.getItem("property-house-details-tab:p1")).toBe("baths");
    expect(written).toHaveLength(1);
    expect(written[0]!.rooms.map((room) => room.name)).toEqual(["Room A", "Attic"]);
    const atticId = written[0]!.rooms.find((room) => room.name === "Attic")!.id;
    expect(written[0]!.bathrooms.some((bath) => (bath.assignedRoomIds ?? []).includes(atticId))).toBe(true);
    capture(
      "15-add-room-landed-on-bathrooms",
      "“+ Add bathroom” landed on the Bathrooms tab with the new bathroom on the house — and the Rooms tab already counts 2, so the room survived the navigation.",
    );

    goToTab("Rooms");
    expect(roomRowNames()).toEqual(["Room A", "Attic"]);
    capture(
      "16-add-room-kept-after-navigation",
      "Back on Rooms: “Attic” is on the house. Before this change the navigation dropped the unsaved room and the manager's typing was gone.",
    );
  });

  it("Cancel is still the one exit that throws the new room away", () => {
    const written: ManagerListingSubmissionV1[] = [];
    render(<HouseDetailsPage onWrite={(sub) => written.push(sub)} />);
    addRoomNamed("Scratch");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(written).toHaveLength(0);
    expect(roomEditorOpen()).toBe(false);
    expect(roomRowNames()).toEqual(["Room A"]);
    capture(
      "17-add-room-cancel-discards",
      "Cancel on the same form: nothing is written and no blank “Room N” is left behind — the house still has one room.",
    );
  });
});
