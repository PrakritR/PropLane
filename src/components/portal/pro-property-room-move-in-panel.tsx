"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { HouseDetailsExpandable } from "@/components/portal/house-info-sections";
import { MoveInMediaFields } from "@/components/portal/move-in-media-fields";
import { PortalPropertyDetailSection } from "@/components/portal/portal-property-detail-section";
import { updateRequestChangeProperty } from "@/lib/demo-admin-property-inventory";
import {
  updateExtraListingFromSubmission,
  updatePendingManagerProperty,
} from "@/lib/demo-property-pipeline";
import type { ManagerListingSubmissionV1, ManagerRoomSubmission } from "@/lib/manager-listing-submission";
import { isEntireHomeListing } from "@/lib/manager-listing-submission";
import { sortRoomIndicesByFloor } from "@/lib/listing-floor-order";

type RoomSaveTarget =
  | { mode: "pending"; saveId: string }
  | { mode: "listing"; saveId: string }
  | { mode: "requestChange"; saveId: string }
  | null;

function moveInCount(instructions: string, photos: string[], video: string | null) {
  return {
    filled: (instructions.trim() ? 1 : 0) + (photos.length > 0 ? 1 : 0) + (video ? 1 : 0),
    total: 3,
  };
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

function residentMoveInShareUrl(): string {
  if (typeof window === "undefined") return "/resident/move-in";
  return `${window.location.origin}/resident/move-in`;
}

function MoveInCardFields({
  instructions,
  photoDataUrls,
  videoDataUrl,
  disabled,
  onInstructionsChange,
  onPhotosChange,
  onVideoChange,
  onError,
  actions,
}: {
  instructions: string;
  photoDataUrls: string[];
  videoDataUrl: string | null;
  disabled: boolean;
  onInstructionsChange: (value: string) => void;
  onPhotosChange: (urls: string[]) => void;
  onVideoChange: (url: string | null) => void;
  onError: (message: string) => void;
  actions?: ReactNode;
}) {
  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1.5 block text-xs font-semibold text-muted">Move-in instructions</label>
        <Textarea
          rows={6}
          className="text-sm"
          disabled={disabled}
          value={instructions}
          onChange={(e) => onInstructionsChange(e.target.value)}
          placeholder="Keys, parking, access codes, what to bring…"
        />
      </div>
      <MoveInMediaFields
        photoDataUrls={photoDataUrls}
        videoDataUrl={videoDataUrl}
        disabled={disabled}
        onPhotosChange={onPhotosChange}
        onVideoChange={onVideoChange}
        onError={onError}
      />
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
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

  const [draftByRoomId, setDraftByRoomId] = useState<Record<string, ManagerRoomSubmission>>({});
  const [houseInstructions, setHouseInstructions] = useState(sub.houseMoveInInstructions ?? "");
  const [housePhotos, setHousePhotos] = useState(sub.houseMoveInPhotoDataUrls ?? []);
  const [houseVideo, setHouseVideo] = useState(sub.houseMoveInVideoDataUrl ?? null);
  const [copyingToRooms, setCopyingToRooms] = useState(false);

  useEffect(() => {
    setDraftByRoomId(Object.fromEntries(sub.rooms.map((room) => [room.id, room])));
    setHouseInstructions(sub.houseMoveInInstructions ?? "");
    setHousePhotos(sub.houseMoveInPhotoDataUrls ?? []);
    setHouseVideo(sub.houseMoveInVideoDataUrl ?? null);
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
      (draft.moveInInstructions ?? "") !== (room.moveInInstructions ?? "") ||
      !roomMediaMatches(draft, room)
    );
  };

  const saveRoom = (room: ManagerRoomSubmission) => {
    const draft = roomDraft(room);
    return persistSubmission(
      {
        ...sub,
        rooms: sub.rooms.map((row) =>
          row.id === room.id
            ? {
                ...row,
                moveInInstructions: draft.moveInInstructions ?? "",
                moveInAvailableDate: row.moveInAvailableDate ?? "",
                moveInPhotoDataUrls: [...(draft.moveInPhotoDataUrls ?? [])],
                moveInVideoDataUrl: draft.moveInVideoDataUrl ?? null,
              }
            : row,
        ),
      },
      "Move-in details saved.",
    );
  };

  const houseDirty =
    houseInstructions !== (sub.houseMoveInInstructions ?? "") ||
    housePhotos.join("|") !== (sub.houseMoveInPhotoDataUrls ?? []).join("|") ||
    (houseVideo ?? null) !== (sub.houseMoveInVideoDataUrl ?? null);

  const saveHouse = () =>
    persistSubmission(
      {
        ...sub,
        houseMoveInInstructions: houseInstructions,
        houseMoveInAvailableDate: sub.houseMoveInAvailableDate ?? "",
        houseMoveInPhotoDataUrls: [...housePhotos],
        houseMoveInVideoDataUrl: houseVideo,
      },
      "Move-in details saved.",
    );

  /** Copying is only meaningful once the house section has something SAVED to copy. */
  const houseHasSavedDetails =
    Boolean(sub.houseMoveInInstructions?.trim()) ||
    (sub.houseMoveInPhotoDataUrls?.length ?? 0) > 0 ||
    Boolean(sub.houseMoveInVideoDataUrl);

  const copyHouseToRooms = () => {
    if (sub.rooms.length === 0 || !houseHasSavedDetails) return;
    setCopyingToRooms(true);
    const saved = {
      moveInInstructions: sub.houseMoveInInstructions ?? "",
      moveInPhotoDataUrls: [...(sub.houseMoveInPhotoDataUrls ?? [])],
      moveInVideoDataUrl: sub.houseMoveInVideoDataUrl ?? null,
    };
    persistSubmission(
      { ...sub, rooms: sub.rooms.map((room) => ({ ...room, ...saved })) },
      sub.rooms.length === 1 ? "Copied to 1 room." : `Copied to ${sub.rooms.length} rooms.`,
    );
    setCopyingToRooms(false);
  };

  const handleShareMoveIn = async () => {
    const url = residentMoveInShareUrl();
    try {
      await navigator.clipboard.writeText(url);
      showToast("Resident House details link copied.");
    } catch {
      showToast(url);
    }
  };

  const showRooms = !entireHome && sub.rooms.length > 0;

  return (
    <PortalPropertyDetailSection>
      <div className="space-y-2.5">
        <HouseDetailsExpandable
          defaultOpen
          dataAttr="property-move-in-house"
          title="The whole house"
          count={moveInCount(houseInstructions, housePhotos, houseVideo)}
          onOpenChange={(open) => {
            if (!open && houseDirty && canEdit) saveHouse();
          }}
        >
          <MoveInCardFields
            instructions={houseInstructions}
            photoDataUrls={housePhotos}
            videoDataUrl={houseVideo}
            disabled={!canEdit}
            onInstructionsChange={setHouseInstructions}
            onPhotosChange={setHousePhotos}
            onVideoChange={setHouseVideo}
            onError={showToast}
            actions={
              canEdit ? (
                <>
                  {houseDirty ? (
                    <Button type="button" variant="primary" onClick={() => saveHouse()}>
                      Save
                    </Button>
                  ) : null}
                  {showRooms ? (
                    <Button
                      type="button"
                      variant="outline"
                      data-attr="property-move-in-copy"
                      disabled={!houseHasSavedDetails || copyingToRooms}
                      onClick={copyHouseToRooms}
                    >
                      Copy to rooms
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="secondary"
                    data-attr="property-move-in-share"
                    onClick={() => void handleShareMoveIn()}
                  >
                    Share
                  </Button>
                </>
              ) : null
            }
          />
        </HouseDetailsExpandable>

        {showRooms
          ? roomIndices.map((index) => {
              const room = sub.rooms[index]!;
              const label = room.name.trim() || `Room ${index + 1}`;
              const draft = roomDraft(room);
              const dirty = roomDirty(room);
              return (
                <div key={room.id} data-attr={`property-move-in-room-${room.id}`}>
                  <HouseDetailsExpandable
                    title={label}
                    count={moveInCount(
                      draft.moveInInstructions ?? "",
                      draft.moveInPhotoDataUrls ?? [],
                      draft.moveInVideoDataUrl ?? null,
                    )}
                    onOpenChange={(open) => {
                      if (!open && dirty && canEdit) saveRoom(room);
                    }}
                  >
                    <MoveInCardFields
                      instructions={draft.moveInInstructions ?? ""}
                      photoDataUrls={draft.moveInPhotoDataUrls ?? []}
                      videoDataUrl={draft.moveInVideoDataUrl ?? null}
                      disabled={!canEdit}
                      onInstructionsChange={(value) =>
                        setDraftByRoomId((prev) => ({
                          ...prev,
                          [room.id]: { ...draft, moveInInstructions: value },
                        }))
                      }
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
                      actions={
                        canEdit && dirty ? (
                          <Button type="button" variant="primary" onClick={() => saveRoom(room)}>
                            Save
                          </Button>
                        ) : null
                      }
                    />
                  </HouseDetailsExpandable>
                </div>
              );
            })
          : null}
      </div>
    </PortalPropertyDetailSection>
  );
}
