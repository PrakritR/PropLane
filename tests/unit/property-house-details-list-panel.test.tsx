/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { PropertyHouseDetailsListPanel } from "@/components/portal/property-house-details-list-panel";
import {
  createDefaultListingSubmission,
  emptyBathroom,
  emptySharedSpace,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { normalizeHouseInfo } from "@/lib/house-info";
import { resolveHouseDetailsTab } from "@/lib/property-house-details-tab";
import { ADD_BATHROOM_VALUE } from "@/lib/listing-room-editor/bathroom-link";

vi.mock("next/navigation", () => ({ usePathname: () => "/portal/properties/all/p1", useRouter: () => ({ push: () => {} }) }));

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) })));
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function listing() {
  const sub = createDefaultListingSubmission();
  sub.rooms = [
    { ...sub.rooms[0]!, id: "room-a", name: "Room A", floor: "2nd floor", occupancyCapacity: 2, bedCount: 2 },
    { ...sub.rooms[0]!, id: "room-b", name: "Room B", floor: "1st floor", occupancyCapacity: 1 },
  ];
  sub.bathrooms = [{ ...emptyBathroom(0), id: "bath-1", name: "Bath 1", location: "2nd floor" }];
  sub.sharedSpaces = [{ ...emptySharedSpace(0), id: "space-1", name: "Kitchen" }];
  return sub;
}

function renderPanel() {
  return render(
    <PropertyHouseDetailsListPanel
      propertyId="p1"
      sub={listing()}
      houseInfo={normalizeHouseInfo(undefined)}
      managerNotes=""
      managerUserId="mgr-1"
      onPersist={() => true}
    />,
  );
}

/** studio-redesign(property-tabs): House details rows are the replica row. */
describe("PropertyHouseDetailsListPanel", () => {
  it("fits the five header tabs in one row beside the search and the round +", () => {
    const { container } = renderPanel();
    const stacks = container.querySelectorAll('[data-slot="portal-list-control-stack"]');
    expect(stacks).toHaveLength(1);
    const nav = stacks[0]!.querySelector('[data-slot="local-destination-nav"]')!;
    const labels = Array.from(nav.querySelectorAll("button")).map((b) => b.textContent ?? "");
    expect(labels.map((l) => l.replace(/\d+$/, ""))).toEqual([
      "Rooms",
      "Bathrooms",
      "Shared spaces",
      "The house",
      "For residents",
    ]);
    // not the stretched equal grid that pushed the active tab out of view
    expect(nav.className).not.toContain("auto-cols-fr");
    // tight tabs: the trimmed side padding is what lets six fit
    expect(nav.querySelector("button")!.className).toContain("px-1.5");
    expect(within(stacks[0] as HTMLElement).getByRole("button", { name: "Add room" })).toBeTruthy();
  });

  it("room rows: square tile, ONE fact line (floor · bath · residents · availability), one ⋯", () => {
    const { container } = renderPanel();
    const rows = container.querySelectorAll(".portal-property-row");
    expect(rows).toHaveLength(2);
    const row = rows[0]!;
    expect(row.querySelector('[data-slot="portal-row-icon-tile"]')).toBeTruthy();
    const facts = row.querySelector('[data-attr="record-row-facts"]')!;
    expect(facts.textContent).toContain("2nd floor");
    expect(facts.textContent).toContain("2 residents · 2 beds");
    expect(facts.textContent).toContain("Available now");
    // the old second line repeated "Furnished · Fully furnished" next to a bare "1"
    expect(row.textContent).not.toMatch(/Furnished.*Furnished/);
    expect(row.querySelectorAll("p")).toHaveLength(1); // the title; no second summary sentence under the facts
    expect(row.querySelectorAll('button[aria-label^="Actions for"], [data-attr="record-actions-single"]')).toHaveLength(1);
  });

  it("every list row on every tab has exactly one ⋯", () => {
    const { container } = renderPanel();
    for (const tab of ["baths", "spaces", "house", "residents"]) {
      fireEvent.click(container.querySelector(`[data-attr="property-house-details-tab-${tab}"]`)!);
      const rows = container.querySelectorAll(".portal-property-row");
      expect(rows.length, tab).toBeGreaterThan(0);
      rows.forEach((row) => {
        expect(row.querySelectorAll('button[aria-label^="Actions for"], [data-attr="record-actions-single"]'), `${tab} row`).toHaveLength(1);
        expect(row.querySelector('[data-slot="portal-row-icon-tile"]'), `${tab} tile`).toBeTruthy();
      });
    }
  });

  it("The house holds Manager notes; Door card and Manager tools are gone from House details", () => {
    const { container } = renderPanel();
    fireEvent.click(container.querySelector('[data-attr="property-house-details-tab-house"]')!);
    for (const row of ["facts", "amenities", "house-rules", "manager-notes"]) {
      expect(container.querySelector(`[data-attr="property-house-details-${row}-row"]`), row).toBeTruthy();
    }
    expect(container.querySelector('[data-attr="property-house-details-manager-notes-row"]')).toBeTruthy();
    expect(container.querySelector('[data-attr="property-house-details-tab-manager"]')).toBeNull();
    // Door card's one home is Promotion -> Flyers & printables.
    for (const tab of ["rooms", "baths", "spaces", "house", "residents"]) {
      fireEvent.click(container.querySelector(`[data-attr="property-house-details-tab-${tab}"]`)!);
      expect(container.querySelector('[data-attr="house-printables-door-card"]'), tab).toBeNull();
      expect(screen.queryByText("Door card"), tab).toBeNull();
    }
  });

  it("Earlier notes shows in The house only when there is something in it", () => {
    const { container, unmount } = renderPanel();
    fireEvent.click(container.querySelector('[data-attr="property-house-details-tab-house"]')!);
    expect(container.querySelector('[data-attr="property-house-details-earlier-notes-row"]')).toBeNull();
    unmount();
    const onOpen = vi.fn();
    const withNotes = render(
      <PropertyHouseDetailsListPanel
        propertyId="p1"
        sub={listing()}
        houseInfo={normalizeHouseInfo(undefined)}
        managerNotes=""
        managerUserId="mgr-1"
        onPersist={() => true}
        earlierNotes={{ onOpen }}
      />,
    );
    fireEvent.click(withNotes.container.querySelector('[data-attr="property-house-details-tab-house"]')!);
    const row = withNotes.container.querySelector('[data-attr="property-house-details-earlier-notes-row"]')!;
    expect(row).toBeTruthy();
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalled();
  });

  it("For residents: the handouts (rules poster, welcome sheet) sit beside the resident-read rows", () => {
    const { container } = renderPanel();
    fireEvent.click(container.querySelector('[data-attr="property-house-details-tab-residents"]')!);
    for (const title of ["Anything else", "House rules poster", "Welcome sheet"]) {
      expect(screen.getByText(title), title).toBeTruthy();
    }
    expect(container.querySelector(".portal-badge-info, .portal-badge-notice")).toBeNull();
    expect(container.textContent).not.toContain("Made from the details above");
  });

  it("old sub-tab ids still land somewhere sensible", () => {
    expect(resolveHouseDetailsTab("info")).toBe("residents");
    expect(resolveHouseDetailsTab("manager")).toBe("house");
    expect(resolveHouseDetailsTab("residents")).toBe("residents");
    expect(resolveHouseDetailsTab("nonsense")).toBeNull();
    window.localStorage.setItem("property-house-details-tab:p1", "manager");
    const { container } = renderPanel();
    expect(container.querySelector('[data-attr="property-house-details-manager-notes-row"]')).toBeTruthy();
  });

  it("opens the room editor Edit-first: the ⋯ lists Edit before Duplicate", () => {
    const { container } = renderPanel();
    fireEvent.keyDown(container.querySelector('button[aria-label="Actions for Room A"]')!, { key: "Enter" });
    const ids = Array.from(document.querySelectorAll("[data-record-action-id]")).map((el) =>
      el.getAttribute("data-record-action-id"),
    );
    expect(ids.indexOf("edit")).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf("edit")).toBeLessThan(ids.indexOf("duplicate"));
  });
});

/**
 * "Closing the wizard saves" (`docs/agents/property-drafts.md`). Add room holds the new room in an
 * unsaved snapshot, so every exit the form offers except Cancel has to write it first — otherwise
 * reaching for "+ Add bathroom" from inside the new-room form threw the room away.
 */
describe("the new-room form saves on its way out", () => {
  function renderNoBathrooms(onPersist: (payload: { sub: ManagerListingSubmissionV1 }) => boolean) {
    const sub = createDefaultListingSubmission();
    sub.rooms = [{ ...sub.rooms[0]!, id: "room-a", name: "Room A" }];
    sub.bathrooms = [];
    return render(
      <PropertyHouseDetailsListPanel
        propertyId="p1"
        sub={sub}
        houseInfo={normalizeHouseInfo(undefined)}
        managerNotes=""
        managerUserId="mgr-1"
        onPersist={onPersist as never}
      />,
    );
  }

  // The editor is a portal, so its nodes hang off document.body rather than the panel's container.
  const addRoomNamed = (name: string) => {
    fireEvent.click(screen.getByRole("button", { name: "Add room" }));
    fireEvent.change(screen.getByLabelText("Room name"), { target: { value: name } });
  };
  const roomEditor = () => document.querySelector('[data-attr="property-house-details-room-editor"]');
  const addBathroomFirst = () => document.querySelector('[data-attr="listing-v2-add-bathroom-first"]')!;

  it("persists the room when + Add bathroom navigates away", () => {
    const onPersist = vi.fn(() => true);
    renderNoBathrooms(onPersist);
    addRoomNamed("Attic");

    // With no bathrooms yet, the bare "+ Add bathroom" button is the only bathroom control.
    fireEvent.click(addBathroomFirst());

    expect(onPersist).toHaveBeenCalledTimes(1);
    const saved = onPersist.mock.calls[0]![0] as unknown as { sub: ManagerListingSubmissionV1 };
    expect(saved.sub.rooms.map((room) => room.name)).toEqual(["Room A", "Attic"]);
    // ...and it lands on the Bathrooms tab with the form closed.
    expect(roomEditor()).toBeNull();
    expect(window.localStorage.getItem("property-house-details-tab:p1")).toBe("baths");
  });

  it("carries a bathroom minted in the same click that navigates away", () => {
    const onPersist = vi.fn(() => true);
    const sub = createDefaultListingSubmission();
    sub.rooms = [{ ...sub.rooms[0]!, id: "room-a", name: "Room A" }];
    sub.bathrooms = [{ ...emptyBathroom(0), id: "bath-1", name: "Bath 1" }];
    render(
      <PropertyHouseDetailsListPanel
        propertyId="p1"
        sub={sub}
        houseInfo={normalizeHouseInfo(undefined)}
        managerNotes=""
        managerUserId="mgr-1"
        onPersist={onPersist as never}
      />,
    );
    addRoomNamed("Attic");

    // With a bathroom already on the house, the dropdown carries the "+ Add bathroom" option: it
    // mints the row into the draft and navigates in the SAME handler.
    const dropdown = screen.getByRole("button", { name: "Bathroom for Attic" });
    fireEvent.click(dropdown);
    const option = document
      .getElementById(dropdown.getAttribute("aria-controls")!)!
      .querySelector(`[data-field-select-option-value="${ADD_BATHROOM_VALUE}"]`)!;
    fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });

    expect(onPersist).toHaveBeenCalledTimes(1);
    const saved = onPersist.mock.calls[0]![0] as unknown as { sub: ManagerListingSubmissionV1 };
    expect(saved.sub.rooms.map((room) => room.name)).toEqual(["Room A", "Attic"]);
    // The bathroom the pick minted into the draft reaches the write: the navigation reads what
    // that same handler produced, not the render's stale copy.
    const atticId = saved.sub.rooms.find((room) => room.name === "Attic")!.id;
    expect(saved.sub.bathrooms.length).toBeGreaterThan(1);
    expect(saved.sub.bathrooms.some((bath) => (bath.assignedRoomIds ?? []).includes(atticId))).toBe(true);
  });

  it("Cancel is the one exit that discards the new room", () => {
    const onPersist = vi.fn(() => true);
    renderNoBathrooms(onPersist);
    addRoomNamed("Attic");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onPersist).not.toHaveBeenCalled();
    expect(roomEditor()).toBeNull();
  });

  it("keeps the form open when the write is refused", () => {
    const onPersist = vi.fn(() => false);
    renderNoBathrooms(onPersist);
    addRoomNamed("Attic");

    fireEvent.click(addBathroomFirst());

    expect(onPersist).toHaveBeenCalledTimes(1);
    expect(roomEditor()).toBeTruthy();
  });
});
