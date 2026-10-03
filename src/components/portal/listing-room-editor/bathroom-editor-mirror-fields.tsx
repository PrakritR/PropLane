"use client";

import { CheckboxMultiSelect, FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import type { ManagerBathroomSubmission, ManagerListingSubmissionV1, ManagerRoomSubmission } from "@/lib/manager-listing-submission";
import {
  applyBathroomRooms,
  bathAccessOf,
  roomBathroomState,
  type BathroomHallLocation,
} from "@/lib/listing-room-editor/bathroom-link";
import { FactRow } from "@/components/portal/listing-wizard-v2/wizard-primitives";

export function BathroomEditorMirrorFields({
  sub,
  bath,
  who,
  onSubmission,
}: {
  sub: ManagerListingSubmissionV1;
  bath: ManagerBathroomSubmission;
  who: string;
  onSubmission: (next: ManagerListingSubmissionV1) => void;
}) {
  const rooms = sub.rooms ?? [];
  const assigned = bath.assignedRoomIds ?? [];
  const access = bathAccessOf(sub, bath);
  const location: BathroomHallLocation =
    bath.accessKindByRoomId?.[assigned[0] ?? ""] === "ensuite" || bath.accessKind === "ensuite" ? "ensuite" : "hall";
  const roomOptions = rooms.map((r, i) => ({
    value: r.id,
    label: r.name.trim() || `Room ${i + 1}`,
  }));

  const patch = (accessNext: "private" | "shared", loc: BathroomHallLocation, roomIds: string[]) => {
    onSubmission(applyBathroomRooms(sub, bath.id, accessNext, loc, roomIds));
  };

  return (
    <>
      <FactRow label="Type">
        <FieldSingleSelect
          hideLabel
          label={`Bathroom type for ${who}`}
          variant="cell"
          className="min-w-[150px] max-w-[220px]"
          options={[
            { value: "private", label: "Private" },
            { value: "shared", label: "Shared" },
          ]}
          value={access}
          onChange={(value) => patch(value as "private" | "shared", location, assigned)}
        />
      </FactRow>
      <FactRow label="Location">
        <FieldSingleSelect
          hideLabel
          label={`Bathroom location for ${who}`}
          variant="cell"
          className="min-w-[150px] max-w-[220px]"
          options={[
            { value: "hall", label: "In the hall" },
            { value: "ensuite", label: "Ensuite" },
          ]}
          value={location}
          onChange={(value) => patch(access, value as BathroomHallLocation, assigned)}
        />
      </FactRow>
      {access === "private" ? (
        <FactRow label="Room">
          <FieldSingleSelect
            hideLabel
            label={`Room for ${who}`}
            variant="cell"
            className="min-w-[150px] max-w-[220px]"
            options={[{ value: "", label: "No room yet" }, ...roomOptions]}
            value={assigned[0] ?? ""}
            onChange={(value) => patch("private", location, value ? [value] : [])}
          />
        </FactRow>
      ) : (
        <FactRow label="Rooms">
          <CheckboxMultiSelect
            hideLabel
            label={`Rooms for ${who}`}
            variant="cell"
            className="min-w-[150px] max-w-[240px]"
            options={roomOptions}
            selected={assigned}
            selectionTriggerLabel={
              assigned.length
                ? assigned.map((id) => roomOptions.find((o) => o.value === id)?.label ?? "Room").join(", ")
                : "Pick rooms"
            }
            emptyLabel="Pick rooms"
            onChange={(next) => patch("shared", location, next)}
          />
        </FactRow>
      )}
    </>
  );
}

export function roomLinkLabel(sub: ManagerListingSubmissionV1, room: ManagerRoomSubmission): string {
  const i = (sub.rooms ?? []).indexOf(room);
  return room.name.trim() || `Room ${i + 1}`;
}

export function bathroomRoomLinks(sub: ManagerListingSubmissionV1, bath: ManagerBathroomSubmission): string {
  const rooms = (sub.rooms ?? []).filter((r) => (bath.assignedRoomIds ?? []).includes(r.id));
  if (!rooms.length) return "No rooms yet";
  return rooms.map((r) => roomLinkLabel(sub, r)).join(", ");
}
