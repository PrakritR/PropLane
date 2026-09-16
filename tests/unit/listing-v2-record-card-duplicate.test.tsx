// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import React, { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  publishManagerPropertyDraftToServer: vi.fn(),
  saveManagerPropertyDraftToServer: vi.fn(),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({ submitManagerPendingPropertyToServer: vi.fn() }));

import { ListingEditorV2 } from "@/components/portal/listing-wizard-v2/listing-editor";
import {
  createDefaultListingSubmission,
  emptyBathroom,
  emptySharedSpace,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";

afterEach(() => cleanup());

const base = createDefaultListingSubmission();
const seeded: ManagerListingSubmissionV1 = {
  ...base,
  rooms: [
    { ...base.rooms[0]!, id: "r1", name: "Studio" },
  ],
  bathrooms: [
    { ...emptyBathroom(0), id: "b1", name: "Full bathroom", assignedRoomIds: ["r1"] },
  ],
  sharedSpaces: [
    { ...emptySharedSpace(0), id: "s1", name: "Kitchen", roomAccessIds: ["r1"] },
  ],
};

function Editor({
  submission = seeded,
  onChange,
}: {
  submission?: ManagerListingSubmissionV1;
  onChange?: (sub: ManagerListingSubmissionV1) => void;
}) {
  const [sub, setSub] = useState(submission);
  return (
    <ListingEditorV2
      title="Edit listing"
      submission={sub}
      isEdit
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

function openStep(step: "rooms" | "bathrooms" | "spaces") {
  fireEvent.click(document.querySelector(`[data-attr="listing-v2-rail-${step}"]`)!);
}

describe("listing v2 record-card Duplicate", () => {
  it("duplicates a room and leaves Default without Duplicate", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    render(<Editor onChange={(sub) => seen.push(sub)} />);
    openStep("rooms");
    expect(screen.queryByRole("button", { name: "Duplicate Default room" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Duplicate Studio" }));
    const next = seen.at(-1)!;
    expect(next.rooms).toHaveLength(2);
    expect(next.rooms[1]!.name).toBe("Studio (copy)");
    expect(next.rooms[1]!.id).not.toBe("r1");
  });

  it("duplicates a bathroom and hides Duplicate on Default bathroom", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    render(<Editor onChange={(sub) => seen.push(sub)} />);
    openStep("bathrooms");
    expect(screen.queryByRole("button", { name: "Duplicate Default bathroom" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Duplicate Full bathroom" }));
    const next = seen.at(-1)!;
    expect(next.bathrooms).toHaveLength(2);
    expect(next.bathrooms[1]!.name).toBe("Full bathroom (copy)");
  });

  it("duplicates a shared space", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    render(<Editor onChange={(sub) => seen.push(sub)} />);
    openStep("spaces");
    fireEvent.click(screen.getByRole("button", { name: "Duplicate Kitchen" }));
    const next = seen.at(-1)!;
    expect(next.sharedSpaces).toHaveLength(2);
    expect(next.sharedSpaces[1]!.name).toBe("Kitchen (copy)");
  });
});
