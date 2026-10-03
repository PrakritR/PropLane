"use client";

import { Button } from "@/components/ui/button";
import {
  ApplicationResidentSlotPicker,
  type ApplicationResidentSlotPickerProps,
} from "@/components/portal/application-resident-slot-picker";

export type SharedRoomApplyMode = "bed" | "room";

export function SharedRoomApplyModePanel({
  mode,
  onModeChange,
  slotPicker,
  groupId,
  roommateContacts,
  onRoommateContactsChange,
}: {
  mode: SharedRoomApplyMode;
  onModeChange: (mode: SharedRoomApplyMode) => void;
  slotPicker: ApplicationResidentSlotPickerProps;
  groupId: string;
  roommateContacts: string;
  onRoommateContactsChange: (value: string) => void;
}) {
  return (
    <div className="space-y-4" data-sr-apply>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant={mode === "bed" ? "primary" : "outline"}
          onClick={() => onModeChange("bed")}
          data-attr="sr-apply-one-bed"
        >
          One bed
        </Button>
        <Button
          type="button"
          variant={mode === "room" ? "primary" : "outline"}
          onClick={() => onModeChange("room")}
          data-attr="sr-apply-whole-room"
        >
          Whole room with roommates
        </Button>
      </div>
      <ApplicationResidentSlotPicker {...slotPicker} />
      {mode === "room" ? (
        <div className="space-y-3">
          <label className="block text-sm font-bold text-foreground">
            Roommate email or phone
            <input
              className="mt-1 w-full rounded-xl border border-border bg-card px-3 py-2.5 text-sm"
              value={roommateContacts}
              onChange={(e) => onRoommateContactsChange(e.target.value)}
              placeholder="friend@example.com"
              data-attr="sr-roommate-invite"
            />
          </label>
          {groupId.trim() ? (
            <p className="text-sm font-semibold text-foreground">Group {groupId.trim()}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
