// @vitest-environment jsdom
//
// Same as Room X must write the source room's numbers onto the record. The
// old "Same as default room" tick could draw $1,050 while the record held $0;
// Review, the applicant's room list and the signed lease read the record.
import { afterEach, describe, expect, it, vi } from "vitest";
import React, { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  publishManagerPropertyDraftToServer: vi.fn(),
  saveManagerPropertyDraftToServer: vi.fn(),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({
  submitManagerPendingPropertyToServer: vi.fn(),
  updateExtraListingFromSubmissionOnServer: vi.fn(),
}));
vi.mock("@/lib/native/app-review", () => ({ recordDelightMoment: vi.fn() }));
vi.mock("@/lib/manager-subscription-client", () => ({ loadManagerPaymentWaiverGrantedClient: vi.fn(async () => false) }));

import { ListingEditorV2, listingReadiness } from "@/components/portal/listing-wizard-v2/listing-editor";
import { ListingWizardV2 } from "@/components/portal/listing-wizard-v2";
import {
  emptyListingHouseDefaults,
  fillRoomsFollowingDefaults,
  resetRoomFieldToDefault,
  type ListingHouseDefaults,
} from "@/lib/listing-house-defaults";
import {
  createDefaultListingSubmission,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";

afterEach(() => cleanup());

const DEFAULTS: ListingHouseDefaults = { ...emptyListingHouseDefaults(), monthlyRent: 1050, utilitiesEstimate: "0", securityDeposit: "250" };

function seeded(rooms: Partial<ManagerRoomSubmission>[]): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  return {
    ...base,
    address: "5257 Brooklyn Avenue Northeast",
    houseOverview: "A house.",
    securityDeposit: "250",
    allowedLeaseTerms: ["Long-term"],
    houseDefaults: DEFAULTS,
    rooms: rooms.map((r, i) => ({ id: `r${i + 1}`, name: `Room ${i + 1}`, monthlyRent: 1050, utilitiesEstimate: "0", securityDeposit: "250", ...r })),
  } as ManagerListingSubmissionV1;
}

function Editor({ initial, onChange }: { initial: ManagerListingSubmissionV1; onChange?: (sub: ManagerListingSubmissionV1) => void }) {
  const [sub, setSub] = useState(initial);
  return (
    <ListingEditorV2
      title="Edit listing"
      submission={sub}
      onChange={(next) => {
        setSub(next);
        onChange?.(next);
      }}
      onClose={() => {}}
      onSaveExit={() => {}}
      onPublish={() => {}}
    />
  );
}

function openPricing() {
  const nav = screen.getByRole("navigation", { name: "Listing sections" });
  fireEvent.click(Array.from(nav.querySelectorAll("button")).find((b) => /pricing/i.test(b.textContent ?? ""))!);
}
const openPriceCard = (name: string) => fireEvent.click(screen.getByRole("button", { name: `Open ${name} prices` }));
const pickSameAs = (who: string, sourceId: string) => {
  const trigger = screen.getByRole("button", { name: `Same as for ${who}` });
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  const option = document.getElementById(trigger.getAttribute("aria-controls")!)!.querySelector(`[data-field-select-option-value="${sourceId}"]`)!;
  fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
};

describe("Same as Room X writes that room's numbers on the record", () => {
  it("picking Same as Room 2 writes $1,050 / $0 / $250 into Room 1, never a blank", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<Editor initial={seeded([{}, {}])} onChange={(s) => (latest = s)} />);
    openPricing();
    expect(document.querySelector('[data-attr="listing-v2-price-defaults-card"]')).toBeNull();
    openPriceCard("Room 1");

    fireEvent.change(screen.getByLabelText(/Room 1 rent on/i), { target: { value: "1200" } });
    expect(latest!.rooms[0]!.monthlyRent).toBe(1200);
    expect(latest!.rooms[1]!.monthlyRent).toBe(1050);

    pickSameAs("Room 1", "r2");
    const room1 = latest!.rooms[0]!;
    expect(room1.monthlyRent).toBe(1050);
    expect(room1.utilitiesEstimate).toBe("0");
    expect(room1.securityDeposit).toBe("250");
    expect(screen.getAllByText("$1,050 · +$0 utilities · $250 deposit · listed $1,050 · partial months automatic")).toHaveLength(2);

    // Review now agrees with the card.
    expect(listingReadiness(latest!).find((c) => c.id === "rooms")).toMatchObject({ label: "2 rooms, all priced", state: "done" });
  });

  it("editing Room 1 after a copy leaves Room 2 alone", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<Editor initial={seeded([{ monthlyRent: 1200, securityDeposit: "900" }, {}])} onChange={(s) => (latest = s)} />);
    openPricing();
    openPriceCard("Room 1");
    pickSameAs("Room 1", "r2");
    fireEvent.change(screen.getByLabelText(/Room 1 rent on/i), { target: { value: "1300" } });

    expect(latest!.rooms[0]!.monthlyRent).toBe(1300);
    expect(latest!.rooms[1]!.monthlyRent).toBe(1050);
  });
});

describe("the helpers", () => {
  const room = (over: Partial<ManagerRoomSubmission>): ManagerRoomSubmission =>
    ({ ...createDefaultListingSubmission().rooms[0]!, id: "r", ...over }) as ManagerRoomSubmission;

  it("resetRoomFieldToDefault writes the card's value, blank included", () => {
    expect(resetRoomFieldToDefault(room({ monthlyRent: 1200 }), "monthlyRent", DEFAULTS).monthlyRent).toBe(1050);
    expect(resetRoomFieldToDefault(room({ securityDeposit: "900" }), "securityDeposit", { ...DEFAULTS, securityDeposit: "" }).securityDeposit).toBe("");
  });

  it("fillRoomsFollowingDefaults fills only blank followers and returns the same array when nothing changes", () => {
    const rooms = [room({ id: "a", monthlyRent: 0, utilitiesEstimate: "", securityDeposit: undefined }), room({ id: "b", monthlyRent: 1200 })];
    const out = fillRoomsFollowingDefaults(rooms, DEFAULTS);
    expect(out[0]).toMatchObject({ monthlyRent: 1050, utilitiesEstimate: "0", securityDeposit: "250" });
    expect(out[1]!.monthlyRent).toBe(1200);
    expect(fillRoomsFollowingDefaults(out, DEFAULTS)).toBe(out);
    // A card with no rent has nothing to fill.
    expect(fillRoomsFollowingDefaults(rooms, emptyListingHouseDefaults())).toBe(rooms);
  });
});

describe("a listing saved while the tick blanked a room heals on open", () => {
  it("Review says all priced without touching Pricing", () => {
    const broken = seeded([{ monthlyRent: 0, utilitiesEstimate: "", securityDeposit: undefined }, {}, {}]);
    expect(listingReadiness(broken).find((c) => c.id === "rooms")!.label).toBe("1 of 3 rooms have no rent");

    render(<ListingWizardV2 initialSubmission={broken} editListingId="listing-1" userId="u1" skuTier="pro" onClose={() => {}} />);
    const nav = screen.getByRole("navigation", { name: "Listing sections" });
    fireEvent.click(Array.from(nav.querySelectorAll("button")).find((b) => /review/i.test(b.textContent ?? ""))!);
    expect(screen.getByText("3 rooms, all priced")).toBeTruthy();
    expect(screen.queryByText(/rooms have no rent/)).toBeNull();
  });
});
