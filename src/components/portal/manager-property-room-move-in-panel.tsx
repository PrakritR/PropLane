"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BulkActionBar } from "@/components/ui/bulk-action-bar";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { PortalAdaptiveActionRow } from "@/components/portal/portal-adaptive-action-row";
import type { PortalAdaptiveAction } from "@/lib/portal-adaptive-actions";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { Textarea } from "@/components/ui/input";
import {
  PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS,
  PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS,
  PortalPropertyDetailSection,
} from "@/components/portal/portal-property-detail-section";
import { PortalDetailHeader } from "@/components/portal/portal-list-detail-shell";
import { MoveInMediaFields } from "@/components/portal/move-in-media-fields";
import { updateRequestChangeProperty } from "@/lib/demo-admin-property-inventory";
import {
  updateExtraListingFromSubmission,
  updatePendingManagerProperty,
} from "@/lib/demo-property-pipeline";
import type { ManagerListingSubmissionV1, ManagerRoomSubmission } from "@/lib/manager-listing-submission";
import { isEntireHomeListing } from "@/lib/manager-listing-submission";
import { sortRoomIndicesByFloor } from "@/lib/listing-floor-order";
import { cn } from "@/lib/utils";

type RoomSaveTarget =
  | { mode: "pending"; saveId: string }
  | { mode: "listing"; saveId: string }
  | { mode: "requestChange"; saveId: string }
  | null;

function MoveInInstructionsField({
  moveInInstructions,
  disabled,
  onInstructionsChange,
}: {
  moveInInstructions: string;
  disabled: boolean;
  onInstructionsChange: (value: string) => void;
}) {
  return (
    <div>
      <label className="text-xs font-semibold text-muted">
        Move-in instructions
        <span className="ml-1.5 font-normal text-muted">— shown to placed residents</span>
      </label>
      <Textarea
        rows={6}
        className="mt-1 text-sm"
        disabled={disabled}
        value={moveInInstructions}
        onChange={(e) => onInstructionsChange(e.target.value)}
        placeholder="Keys, parking, access codes, what to bring…"
      />
    </div>
  );
}

function roomMoveInSummary(room: ManagerRoomSubmission): string {
  const parts: string[] = [];
  if (room.moveInInstructions?.trim()) parts.push("Instructions set");
  if ((room.moveInPhotoDataUrls?.length ?? 0) > 0) parts.push(`${room.moveInPhotoDataUrls!.length} photo(s)`);
  if (room.moveInVideoDataUrl) parts.push("Video");
  if (parts.length > 0) return parts.join(" · ");
  return "No move-in details yet";
}

function roomMediaMatches(a: ManagerRoomSubmission, b: ManagerRoomSubmission): boolean {
  const aPhotos = a.moveInPhotoDataUrls ?? [];
  const bPhotos = b.moveInPhotoDataUrls ?? [];
  return (
    aPhotos.length === bPhotos.length &&
    aPhotos.every((url, index) => url === bPhotos[index]) &&
    (a.moveInVideoDataUrl ?? null) === (b.moveInVideoDataUrl ?? null)
  );
}

export function ManagerPropertyRoomMoveInPanel({
  sub,
  saveTarget,
  managerUserId,
  canEdit,
  onUpdated,
  showToast,
}: {
  sub: ManagerListingSubmissionV1;
  saveTarget: RoomSaveTarget;
  managerUserId: string | null;
  canEdit: boolean;
  onUpdated: () => void;
  showToast: (message: string) => void;
}) {
  const entireHome = isEntireHomeListing(sub);
  const roomIndices = useMemo(() => sortRoomIndicesByFloor(sub.rooms), [sub.rooms]);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [draftByRoomId, setDraftByRoomId] = useState<Record<string, ManagerRoomSubmission>>({});
  const [houseInstructions, setHouseInstructions] = useState(sub.houseMoveInInstructions ?? "");
  const [housePhotos, setHousePhotos] = useState(sub.houseMoveInPhotoDataUrls ?? []);
  const [houseVideo, setHouseVideo] = useState(sub.houseMoveInVideoDataUrl ?? null);
  const [savingRoomId, setSavingRoomId] = useState<string | null>(null);
  const [savingHouse, setSavingHouse] = useState(false);
  const [selectedRoomIds, setSelectedRoomIds] = useState<string[]>([]);
  const [copyingToRooms, setCopyingToRooms] = useState(false);

  useEffect(() => {
    setDraftByRoomId(Object.fromEntries(sub.rooms.map((room) => [room.id, room])));
    setHouseInstructions(sub.houseMoveInInstructions ?? "");
    setHousePhotos(sub.houseMoveInPhotoDataUrls ?? []);
    setHouseVideo(sub.houseMoveInVideoDataUrl ?? null);
    setSelectedRoomId((current) =>
      current && sub.rooms.some((room) => room.id === current) ? current : null,
    );
    setSelectedRoomIds((current) => current.filter((id) => sub.rooms.some((room) => room.id === id)));
  }, [sub]);

  const persistSubmission = (nextSub: ManagerListingSubmissionV1, successMessage: string) => {
    if (!managerUserId || !saveTarget || !canEdit) return false;
    let ok = false;
    if (saveTarget.mode === "pending") {
      ok = updatePendingManagerProperty(saveTarget.saveId, nextSub, managerUserId);
    } else if (saveTarget.mode === "listing") {
      ok = updateExtraListingFromSubmission(saveTarget.saveId, managerUserId, nextSub);
    } else if (saveTarget.mode === "requestChange") {
      ok = updateRequestChangeProperty(saveTarget.saveId, managerUserId, nextSub);
    }
    if (!ok) {
      showToast("Could not save move-in details.");
      return false;
    }
    showToast(successMessage);
    onUpdated();
    return true;
  };

  const roomDraft = (room: ManagerRoomSubmission) => draftByRoomId[room.id] ?? room;

  const roomDirty = (room: ManagerRoomSubmission) => {
    const draft = roomDraft(room);
    return (
      (draft.moveInInstructions ?? "") !== (room.moveInInstructions ?? "") || !roomMediaMatches(draft, room)
    );
  };

  const saveRoom = (room: ManagerRoomSubmission) => {
    const draft = roomDraft(room);
    setSavingRoomId(room.id);
    persistSubmission(
      {
        ...sub,
        rooms: sub.rooms.map((r) =>
          r.id === room.id
            ? {
                ...r,
                moveInInstructions: draft.moveInInstructions ?? "",
                moveInPhotoDataUrls: [...(draft.moveInPhotoDataUrls ?? [])],
                moveInVideoDataUrl: draft.moveInVideoDataUrl ?? null,
              }
            : r,
        ),
      },
      "Move-in details saved.",
    );
    setSavingRoomId(null);
  };

  const houseDirty =
    houseInstructions !== (sub.houseMoveInInstructions ?? "") ||
    housePhotos.join("|") !== (sub.houseMoveInPhotoDataUrls ?? []).join("|") ||
    (houseVideo ?? null) !== (sub.houseMoveInVideoDataUrl ?? null);

  const saveHouse = () => {
    setSavingHouse(true);
    persistSubmission(
      {
        ...sub,
        houseMoveInInstructions: houseInstructions,
        houseMoveInPhotoDataUrls: [...housePhotos],
        houseMoveInVideoDataUrl: houseVideo,
      },
      "Move-in details saved.",
    );
    setSavingHouse(false);
  };

  /** Copying is only meaningful once the house section has something SAVED to copy. */
  const houseHasSavedDetails =
    Boolean(sub.houseMoveInInstructions?.trim()) ||
    (sub.houseMoveInPhotoDataUrls?.length ?? 0) > 0 ||
    Boolean(sub.houseMoveInVideoDataUrl);

  const toggleRoomSelected = (roomId: string) => {
    setSelectedRoomIds((current) =>
      current.includes(roomId) ? current.filter((id) => id !== roomId) : [...current, roomId],
    );
  };

  const allRoomIds = roomIndices.map((index) => sub.rooms[index]!.id);
  const allRoomsSelected = allRoomIds.length > 0 && allRoomIds.every((id) => selectedRoomIds.includes(id));
  const someRoomsSelected = selectedRoomIds.length > 0 && !allRoomsSelected;

  /**
   * Put the SAVED house move-in details onto the selected rooms.
   *
   * Most of what a manager types per room is the same door code and parking note
   * repeated, so this is the whole reason the rooms are selectable. It copies the
   * saved values, not the unsaved draft, so what lands on a room is exactly what
   * the house section shows.
   */
  const copyHouseToSelectedRooms = () => {
    const targets = new Set(selectedRoomIds);
    if (targets.size === 0) return;
    setCopyingToRooms(true);
    const saved = {
      moveInInstructions: sub.houseMoveInInstructions ?? "",
      moveInPhotoDataUrls: [...(sub.houseMoveInPhotoDataUrls ?? [])],
      moveInVideoDataUrl: sub.houseMoveInVideoDataUrl ?? null,
    };
    const ok = persistSubmission(
      { ...sub, rooms: sub.rooms.map((room) => (targets.has(room.id) ? { ...room, ...saved } : room)) },
      targets.size === 1 ? "Copied to 1 room." : `Copied to ${targets.size} rooms.`,
    );
    if (ok) setSelectedRoomIds([]);
    setCopyingToRooms(false);
  };

  if (entireHome) {
    return (
      <PortalPropertyDetailSection
        actions={
          canEdit ? (
            <Button
              type="button"
              variant="primary"
              className={PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS}
              data-attr="house-move-in-save"
              disabled={!houseDirty || savingHouse}
              onClick={saveHouse}
            >
              {savingHouse ? "Saving…" : "Save"}
            </Button>
          ) : null
        }
      >
        <div className="px-1">
          <p className="text-sm text-muted">
            Whole-home move-in details shown to placed residents.
          </p>
          <div className="mt-4">
            <MoveInInstructionsField
              moveInInstructions={houseInstructions}
              disabled={!canEdit}
              onInstructionsChange={setHouseInstructions}
            />
            <MoveInMediaFields
              photoDataUrls={housePhotos}
              videoDataUrl={houseVideo}
              disabled={!canEdit}
              onPhotosChange={setHousePhotos}
              onVideoChange={setHouseVideo}
              onError={showToast}
            />
          </div>
        </div>
      </PortalPropertyDetailSection>
    );
  }

  if (sub.rooms.length === 0) {
    return (
      <PortalPropertyDetailSection>
        <p className="px-1 text-sm text-muted">Add rooms in Edit listing to set per-room move-in details.</p>
      </PortalPropertyDetailSection>
    );
  }

  if (selectedRoomId) {
    const roomIndex = sub.rooms.findIndex((room) => room.id === selectedRoomId);
    const room = roomIndex >= 0 ? sub.rooms[roomIndex]! : null;
    if (!room) {
      return null;
    }
    const draft = roomDraft(room);
    const label = room.name.trim() || `Room ${roomIndex + 1}`;
    const dirty = roomDirty(room);

    return (
      <PortalPropertyDetailSection
        actions={
          canEdit ? (
            <Button
              type="button"
              variant="primary"
              className={PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS}
              data-attr="room-move-in-save"
              disabled={!dirty || savingRoomId === room.id}
              onClick={() => saveRoom(room)}
            >
              {savingRoomId === room.id ? "Saving…" : "Save"}
            </Button>
          ) : null
        }
      >
        <PortalDetailHeader
          bare
          title={label}
          subtitle={room.floor.trim() || undefined}
          onBack={() => setSelectedRoomId(null)}
          backLabel="Rooms"
          hideBackText
          dataAttrBack="property-move-in-back"
        />
        <div className="mt-4 px-1">
          <MoveInInstructionsField
            moveInInstructions={draft.moveInInstructions ?? ""}
            disabled={!canEdit}
            onInstructionsChange={(value) =>
              setDraftByRoomId((prev) => ({
                ...prev,
                [room.id]: { ...draft, moveInInstructions: value },
              }))
            }
          />
          <MoveInMediaFields
            photoDataUrls={draft.moveInPhotoDataUrls ?? []}
            videoDataUrl={draft.moveInVideoDataUrl ?? null}
            disabled={!canEdit}
            onPhotosChange={(urls) =>
              setDraftByRoomId((prev) => ({
                ...prev,
                [room.id]: { ...draft, moveInPhotoDataUrls: urls },
              }))
            }
            onVideoChange={(url) =>
              setDraftByRoomId((prev) => ({
                ...prev,
                [room.id]: { ...draft, moveInVideoDataUrl: url },
              }))
            }
            onError={showToast}
          />
        </div>
      </PortalPropertyDetailSection>
    );
  }

  const bulkSelectionActions: PortalAdaptiveAction[] = [
    {
      id: "clear",
      keepPriority: 1,
      node: (
        <Button
          type="button"
          variant="outline"
          className={PORTAL_BULK_BAR_BTN}
          data-attr="property-move-in-clear-selection"
          onClick={() => setSelectedRoomIds([])}
        >
          Clear
        </Button>
      ),
      menuItem: (
        <DropdownMenuItem
          data-attr="property-move-in-clear-selection"
          onSelect={() => setSelectedRoomIds([])}
        >
          Clear
        </DropdownMenuItem>
      ),
    },
    {
      id: "copy-house",
      keepPriority: 2,
      node: (
        <Button
          type="button"
          variant="primary"
          className={PORTAL_BULK_BAR_BTN}
          data-attr="property-move-in-copy-house"
          disabled={copyingToRooms || !houseHasSavedDetails}
          onClick={() => copyHouseToSelectedRooms()}
        >
          Copy house details here
        </Button>
      ),
      menuItem: (
        <DropdownMenuItem
          data-attr="property-move-in-copy-house"
          disabled={copyingToRooms || !houseHasSavedDetails}
          onSelect={() => copyHouseToSelectedRooms()}
        >
          Copy house details here
        </DropdownMenuItem>
      ),
    },
  ];

  return (
    <>
      {/*
        A room-by-room listing has TWO kinds of move-in detail and only ever
        offered one (AXI-163): the shared house facts — front door code, parking,
        bins — and then what is specific to each room. The house section was
        entire-home only, so there was nowhere to put the shared half except into
        every room by hand.
      */}
      <PortalPropertyDetailSection
        actions={
          canEdit ? (
            <Button
              type="button"
              variant="primary"
              className={PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS}
              data-attr="house-move-in-save"
              disabled={!houseDirty || savingHouse}
              onClick={saveHouse}
            >
              {savingHouse ? "Saving…" : "Save"}
            </Button>
          ) : null
        }
      >
        <div className="px-1">
          {/*
            The house is a selectable row like the rooms below it, not a bare
            label: ticking it selects every room, which is the commonest thing a
            manager wants ("put these details everywhere"). A heading with no
            checkbox sitting above a list of checkboxes reads as a control that
            is broken rather than one that was never offered.
          */}
          <div className="flex items-start gap-2.5">
            {canEdit && allRoomIds.length > 0 ? (
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0 rounded border-border"
                checked={allRoomsSelected}
                ref={(node) => {
                  if (node) node.indeterminate = someRoomsSelected;
                }}
                aria-label="Select every room in the house"
                data-attr="property-move-in-select-whole-house"
                onChange={() => setSelectedRoomIds(allRoomsSelected ? [] : allRoomIds)}
              />
            ) : null}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground">The whole house</p>
              <p className="mt-0.5 text-sm text-muted">
                Shown to every resident here, whichever room they take.
              </p>
            </div>
          </div>
          <div className="mt-4">
            <MoveInInstructionsField
              moveInInstructions={houseInstructions}
              disabled={!canEdit}
              onInstructionsChange={setHouseInstructions}
            />
            <MoveInMediaFields
              photoDataUrls={housePhotos}
              videoDataUrl={houseVideo}
              disabled={!canEdit}
              onPhotosChange={setHousePhotos}
              onVideoChange={setHouseVideo}
              onError={showToast}
            />
          </div>
        </div>
      </PortalPropertyDetailSection>

      <PortalPropertyDetailSection>
        <p className="mb-3 px-1 text-sm text-muted">
          Then anything specific to a room. Tick rooms to copy the house details into them.
        </p>
        <div className="divide-y divide-border/50">
          {roomIndices.map((index) => {
            const room = sub.rooms[index]!;
            const label = room.name.trim() || `Room ${index + 1}`;
            const checked = selectedRoomIds.includes(room.id);

            return (
              <div
                key={room.id}
                className={cn(
                  PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS,
                  "flex items-start gap-2.5 rounded-lg px-1 transition",
                  checked ? "border-l-2 border-l-primary bg-primary/5" : "hover:bg-accent/20",
                )}
              >
                {canEdit ? (
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 shrink-0 rounded border-border"
                    checked={checked}
                    aria-label={`Select ${label}`}
                    data-attr={`property-move-in-room-select-${room.id}`}
                    onChange={() => toggleRoomSelected(room.id)}
                  />
                ) : null}
                <button
                  type="button"
                  data-attr={`property-move-in-room-${room.id}`}
                  className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 text-left"
                  onClick={() => setSelectedRoomId(room.id)}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-foreground">{label}</p>
                    <p className="mt-0.5 text-xs text-muted">
                      {[room.floor.trim() || null, roomMoveInSummary(room)].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
      </PortalPropertyDetailSection>

      {/*
        Same shape as every other bulk bar in the portal: `hideCount` +
        `variant="payments"` and an adaptive action row, so the actions sit on
        the left gutter with the list instead of floating centred behind an
        "N selected" label nobody reads — the selection is already visible in
        the rows themselves.
      */}
      <BulkActionBar count={selectedRoomIds.length} hideCount variant="payments">
        <PortalAdaptiveActionRow actions={bulkSelectionActions} />
      </BulkActionBar>
    </>
  );
}
