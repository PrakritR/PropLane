"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Copy, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { HouseDetailsExpandable, SectionCountPill } from "@/components/portal/house-info-sections";
import { MoveInMediaFields } from "@/components/portal/move-in-media-fields";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalPropertyDetailSection } from "@/components/portal/portal-property-detail-section";
import { updateRequestChangeProperty } from "@/lib/demo-admin-property-inventory";
import {
  updateExtraListingFromSubmission,
  updatePendingManagerProperty,
} from "@/lib/demo-property-pipeline";
import type {
  ManagerListingSubmissionV1,
  ManagerRoomResidentMoveIn,
  ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { isEntireHomeListing, reconcileRoomResidentMoveIn } from "@/lib/manager-listing-submission";
import { sortRoomIndicesByFloor } from "@/lib/listing-floor-order";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";
import { roomMoveInClipboardText, roomMoveInShareUrl } from "@/lib/move-in-share";

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

/** Deep-compares the per-resident move-in rows for the room-row dirty check. */
function residentMoveInMatches(a: ManagerRoomSubmission, b: ManagerRoomSubmission): boolean {
  const aRows = a.moveInResidentDetails ?? [];
  const bRows = b.moveInResidentDetails ?? [];
  if (aRows.length !== bRows.length) return false;
  return aRows.every((row, index) => {
    const other = bRows[index]!;
    const aPhotos = row.moveInPhotoDataUrls;
    const bPhotos = other.moveInPhotoDataUrls;
    return (
      row.moveInInstructions === other.moveInInstructions &&
      (row.moveInVideoDataUrl ?? null) === (other.moveInVideoDataUrl ?? null) &&
      aPhotos.length === bPhotos.length &&
      aPhotos.every((url, i) => url === bPhotos[i])
    );
  });
}

function emptyResidentMoveInEntry(): ManagerRoomResidentMoveIn {
  return { moveInInstructions: "", moveInPhotoDataUrls: [], moveInVideoDataUrl: null };
}

function residentMoveInShareUrl(): string {
  if (typeof window === "undefined") return "/resident/move-in";
  return `${window.location.origin}/resident/move-in`;
}

/** "Saved details" is what is on the SAVED room, never the unsaved draft — same rule as the house section. */
function roomHasSavedDetails(room: ManagerRoomSubmission): boolean {
  return (
    Boolean(room.moveInInstructions?.trim()) ||
    (room.moveInPhotoDataUrls?.length ?? 0) > 0 ||
    Boolean(room.moveInVideoDataUrl)
  );
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
      !roomMediaMatches(draft, room) ||
      !residentMoveInMatches(draft, room)
    );
  };

  const saveRoom = (room: ManagerRoomSubmission) => {
    const draft = roomDraft(room);
    return persistSubmission(
      {
        ...sub,
        rooms: sub.rooms.map((row) =>
          row.id === room.id
            ? reconcileRoomResidentMoveIn({
                ...row,
                moveInInstructions: draft.moveInInstructions ?? "",
                moveInAvailableDate: row.moveInAvailableDate ?? "",
                moveInPhotoDataUrls: [...(draft.moveInPhotoDataUrls ?? [])],
                moveInVideoDataUrl: draft.moveInVideoDataUrl ?? null,
                moveInResidentDetails: (draft.moveInResidentDetails ?? []).map((entry) => ({
                  ...entry,
                  moveInPhotoDataUrls: [...entry.moveInPhotoDataUrls],
                })),
              })
            : row,
        ),
      },
      "Move-in details saved.",
    );
  };

  /** Ticking on seeds empty entries to capacity; ticking off clears the array. Saved on Save / collapse. */
  const toggleResidentDetails = (room: ManagerRoomSubmission, capacity: number, checked: boolean) => {
    const draft = roomDraft(room);
    const nextDetails = checked
      ? Array.from({ length: capacity }, () => emptyResidentMoveInEntry())
      : [];
    setDraftByRoomId((prev) => ({ ...prev, [room.id]: { ...draft, moveInResidentDetails: nextDetails } }));
  };

  const updateResidentDetail = (
    room: ManagerRoomSubmission,
    index: number,
    patch: Partial<ManagerRoomResidentMoveIn>,
  ) => {
    const draft = roomDraft(room);
    const details = draft.moveInResidentDetails ?? [];
    const nextDetails = details.map((entry, i) => (i === index ? { ...entry, ...patch } : entry));
    setDraftByRoomId((prev) => ({ ...prev, [room.id]: { ...draft, moveInResidentDetails: nextDetails } }));
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
    // Only the three house-level fields are spread over the saved room, so each
    // room's own `moveInResidentDetails` (set on the Rooms card) survives.
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
          actions={
            canEdit ? (
              <>
                {showRooms ? (
                  <PortalIconAction
                    icon={Copy}
                    label="Copy house details to rooms"
                    data-attr="property-move-in-copy"
                    disabled={!houseHasSavedDetails || copyingToRooms}
                    onClick={copyHouseToRooms}
                  />
                ) : null}
                <PortalIconAction
                  icon={Share2}
                  label="Share house details"
                  data-attr="property-move-in-share"
                  onClick={() => void handleShareMoveIn()}
                />
              </>
            ) : null
          }
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
              canEdit && houseDirty ? (
                <Button type="button" variant="primary" onClick={() => saveHouse()}>
                  Save
                </Button>
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
              const capacity = normalizeRoomOccupancyCapacity(room.occupancyCapacity);
              const perResidentOn = (draft.moveInResidentDetails?.length ?? 0) >= 1;

              const copyRoomToClipboard = (r: ManagerRoomSubmission) => () => {
                const text = roomMoveInClipboardText({
                  roomLabel: label,
                  instructions: r.moveInInstructions ?? "",
                  photoCount: (r.moveInPhotoDataUrls ?? []).length,
                  hasVideo: Boolean(r.moveInVideoDataUrl),
                  residents: (r.moveInResidentDetails ?? []).map((entry, i) => ({
                    slot: i + 1,
                    instructions: entry.moveInInstructions,
                    photoCount: entry.moveInPhotoDataUrls.length,
                    hasVideo: Boolean(entry.moveInVideoDataUrl),
                  })),
                });
                void navigator.clipboard.writeText(text).then(
                  () => showToast(`${label} move-in info copied.`),
                  () => showToast("Could not copy move-in info."),
                );
              };

              const shareRoom = (r: ManagerRoomSubmission) => () => {
                const url =
                  typeof window === "undefined"
                    ? "/resident/move-in"
                    : roomMoveInShareUrl(window.location.origin, r.id);
                void navigator.clipboard.writeText(url).then(
                  () => showToast(`${label} move-in link copied.`),
                  () => showToast(url),
                );
              };

              return (
                <div key={room.id} data-attr={`property-move-in-room-${room.id}`}>
                  <HouseDetailsExpandable
                    title={label}
                    count={moveInCount(
                      draft.moveInInstructions ?? "",
                      draft.moveInPhotoDataUrls ?? [],
                      draft.moveInVideoDataUrl ?? null,
                    )}
                    actions={
                      <>
                        <PortalIconAction
                          icon={Copy}
                          label={`Copy ${label} move-in info`}
                          data-attr="property-move-in-room-copy"
                          disabled={!roomHasSavedDetails(room)}
                          onClick={copyRoomToClipboard(room)}
                        />
                        <PortalIconAction
                          icon={Share2}
                          label={`Share ${label} move-in info`}
                          data-attr="property-move-in-room-share"
                          onClick={shareRoom(room)}
                        />
                      </>
                    }
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

                    {capacity >= 2 ? (
                      <div className="-mx-4">
                        <div className="flex min-h-[52px] items-center justify-between gap-3 border-t border-border px-3.5 py-2">
                          <label className="flex cursor-pointer items-center gap-2">
                            <input
                              type="checkbox"
                              checked={perResidentOn}
                              disabled={!canEdit}
                              data-attr="property-move-in-per-resident"
                              onChange={(e) => toggleResidentDetails(room, capacity, e.target.checked)}
                              className="h-4 w-4 shrink-0 rounded border-border"
                            />
                            <span className="text-[14px] font-semibold text-foreground">
                              Different instructions per resident
                            </span>
                          </label>
                          <span className="text-[13px] font-semibold text-muted">{`${capacity} residents · set on Rooms`}</span>
                        </div>

                        {perResidentOn
                          ? (draft.moveInResidentDetails ?? []).map((entry, entryIndex) => {
                              const slot = entryIndex + 1;
                              const slotCount = moveInCount(
                                entry.moveInInstructions,
                                entry.moveInPhotoDataUrls,
                                entry.moveInVideoDataUrl,
                              );
                              return (
                                <div
                                  key={slot}
                                  data-attr="property-move-in-resident-block"
                                  data-slot={String(slot)}
                                >
                                  <div className="flex items-center justify-between border-t border-border bg-foreground/[0.025] px-3.5 pb-1 pt-3 text-[11.5px] font-bold uppercase tracking-[0.06em] text-muted">
                                    <span>{`Resident ${slot}`}</span>
                                    <SectionCountPill filled={slotCount.filled} total={slotCount.total} />
                                  </div>
                                  <div className="px-3.5 pt-3">
                                    <MoveInCardFields
                                      instructions={entry.moveInInstructions}
                                      photoDataUrls={entry.moveInPhotoDataUrls}
                                      videoDataUrl={entry.moveInVideoDataUrl}
                                      disabled={!canEdit}
                                      onInstructionsChange={(value) =>
                                        updateResidentDetail(room, entryIndex, { moveInInstructions: value })
                                      }
                                      onPhotosChange={(urls) =>
                                        updateResidentDetail(room, entryIndex, { moveInPhotoDataUrls: urls })
                                      }
                                      onVideoChange={(url) =>
                                        updateResidentDetail(room, entryIndex, { moveInVideoDataUrl: url })
                                      }
                                      onError={showToast}
                                    />
                                  </div>
                                </div>
                              );
                            })
                          : null}
                      </div>
                    ) : null}
                  </HouseDetailsExpandable>
                </div>
              );
            })
          : null}
      </div>
    </PortalPropertyDetailSection>
  );
}
