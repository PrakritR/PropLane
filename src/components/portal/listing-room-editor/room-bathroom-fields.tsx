"use client";

import { CheckboxMultiSelect, FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import type { ManagerListingSubmissionV1, ManagerRoomSubmission } from "@/lib/manager-listing-submission";
import {
  ADD_BATHROOM_VALUE,
  addBathroomForRoom,
  applyRoomBathroom,
  assignRoomToBathroom,
  bathroomOptionsForRoom,
  isAddBathroomOption,
  roomBathroomState,
  type BathroomHallLocation,
  type RoomBathroomMode,
} from "@/lib/listing-room-editor/bathroom-link";
import { FactRow, RowSelectCell } from "@/components/portal/listing-wizard-v2/wizard-primitives";

const MODE_OPTIONS = [
  { value: "private", label: "Private" },
  { value: "shared", label: "Shared" },
  { value: "none", label: "None" },
] as const;

const LOC_OPTIONS = [
  { value: "hall", label: "In the hall" },
  { value: "ensuite", label: "Ensuite" },
] as const;

export function RoomBathroomFields({
  sub,
  room,
  who,
  onSubmission,
  onGoToBathrooms,
}: {
  sub: ManagerListingSubmissionV1;
  room: ManagerRoomSubmission;
  who: string;
  onSubmission: (next: ManagerListingSubmissionV1) => void;
  onGoToBathrooms?: () => void;
}) {
  const baths = sub.bathrooms ?? [];
  const rooms = sub.rooms ?? [];
  const st = roomBathroomState(sub, room.id);
  const otherRooms = rooms.filter((r) => r.id !== room.id).map((r, i) => ({
    value: r.id,
    label: r.name.trim() || `Room ${rooms.indexOf(r) + 1}`,
  }));

  const bath = st.bath;
  const dropdownValue = st.mode === "none" ? "" : bath?.id ?? "";

  const setMode = (mode: RoomBathroomMode, location: BathroomHallLocation, sharedWith: string[]) => {
    onSubmission(applyRoomBathroom(sub, room.id, mode, location, sharedWith));
  };

  if (baths.length === 0) {
    return (
      <FactRow label="Bathroom">
        <button
          type="button"
          onClick={onGoToBathrooms}
          className="text-[13.5px] font-bold text-primary hover:underline"
          data-attr="listing-v2-add-bathroom-first"
        >
          + Add bathroom
        </button>
      </FactRow>
    );
  }

  return (
    <>
      <FactRow label="Bathroom">
        <RowSelectCell
          ariaLabel={`Bathroom for ${who}`}
          value={dropdownValue}
          options={[
            { value: "", label: "None" },
            ...bathroomOptionsForRoom(sub, room.id).filter((o) => o.value !== ADD_BATHROOM_VALUE),
            { value: ADD_BATHROOM_VALUE, label: "+ Add bathroom" },
          ]}
          placeholder="Select…"
          onChange={(value) => {
            if (isAddBathroomOption(value)) {
              onSubmission(addBathroomForRoom(sub, room.id));
              onGoToBathrooms?.();
              return;
            }
            if (!value) {
              setMode("none", "hall", []);
              return;
            }
            if (!baths.some((b) => b.id === value)) return;
            onSubmission(assignRoomToBathroom(sub, room.id, value));
          }}
        />
      </FactRow>
      <FactRow label="Access">
        <FieldSingleSelect
          hideLabel
          label={`Bathroom access for ${who}`}
          variant="cell"
          className="min-w-[150px] max-w-[220px]"
          options={MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          value={st.mode}
          onChange={(mode) => setMode(mode as RoomBathroomMode, st.location, st.sharedWithRoomIds)}
        />
      </FactRow>
      {st.mode === "private" || st.mode === "shared" ? (
        <FactRow label="Location">
          <FieldSingleSelect
            hideLabel
            label={`Bathroom location for ${who}`}
            variant="cell"
            className="min-w-[150px] max-w-[220px]"
            options={LOC_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            value={st.location}
            onChange={(loc) => setMode(st.mode, loc as BathroomHallLocation, st.sharedWithRoomIds)}
          />
        </FactRow>
      ) : null}
      {st.mode === "shared" ? (
        <FactRow label="Shared with">
          <CheckboxMultiSelect
            hideLabel
            label={`Rooms sharing bath with ${who}`}
            variant="cell"
            className="min-w-[150px] max-w-[240px]"
            options={otherRooms}
            selected={st.sharedWithRoomIds}
            selectionTriggerLabel={
              st.sharedWithRoomIds.length
                ? st.sharedWithRoomIds
                    .map((id) => otherRooms.find((o) => o.value === id)?.label ?? "Room")
                    .join(", ")
                : "Pick rooms"
            }
            emptyLabel="Pick rooms"
            onChange={(next) => setMode("shared", st.location, next)}
          />
        </FactRow>
      ) : null}
    </>
  );
}
