"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { BulkActionBar } from "@/components/ui/bulk-action-bar";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/input";
import { PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS, PortalPropertyDetailSection } from "@/components/portal/portal-property-detail-section";
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
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { cn } from "@/lib/utils";

type RoomSaveTarget =
  | { mode: "pending"; saveId: string }
  | { mode: "listing"; saveId: string }
  | { mode: "requestChange"; saveId: string }
  | null;

const HOUSE_MOVE_IN_TARGET_ID = "__house__";
type MoveInEditTarget = typeof HOUSE_MOVE_IN_TARGET_ID | string;

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

function houseMoveInSummary(sub: ManagerListingSubmissionV1): string {
  const parts: string[] = [];
  if (sub.houseMoveInInstructions?.trim()) parts.push("Instructions set");
  const photoCount = sub.houseMoveInPhotoDataUrls?.length ?? 0;
  if (photoCount > 0) parts.push(photoCount === 1 ? "1 photo" : `${photoCount} photos`);
  if (sub.houseMoveInVideoDataUrl) parts.push("Video");
  return parts.length > 0 ? parts.join(" · ") : "Nothing set yet";
}

function roomMoveInSummary(room: ManagerRoomSubmission): string {
  const parts: string[] = [];
  if (room.moveInInstructions?.trim()) parts.push("Instructions set");
  if ((room.moveInPhotoDataUrls?.length ?? 0) > 0) {
    const count = room.moveInPhotoDataUrls!.length;
    parts.push(count === 1 ? "1 photo" : `${count} photos`);
  }
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

function residentMoveInShareUrl(): string {
  if (typeof window === "undefined") return "/resident/move-in";
  return `${window.location.origin}/resident/move-in`;
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

  const [editingTarget, setEditingTarget] = useState<MoveInEditTarget | null>(null);
  const [draftByRoomId, setDraftByRoomId] = useState<Record<string, ManagerRoomSubmission>>({});
  const [houseInstructions, setHouseInstructions] = useState(sub.houseMoveInInstructions ?? "");
  const [housePhotos, setHousePhotos] = useState(sub.houseMoveInPhotoDataUrls ?? []);
  const [houseVideo, setHouseVideo] = useState(sub.houseMoveInVideoDataUrl ?? null);
  const [selectedRoomIds, setSelectedRoomIds] = useState<string[]>([]);
  const [houseSelected, setHouseSelected] = useState(false);
  const [copyingToRooms, setCopyingToRooms] = useState(false);

  const selectionActive = houseSelected || selectedRoomIds.length > 0;
  const selectionCount = (houseSelected ? 1 : 0) + selectedRoomIds.length;

  useEffect(() => {
    setDraftByRoomId(Object.fromEntries(sub.rooms.map((room) => [room.id, room])));
    setHouseInstructions(sub.houseMoveInInstructions ?? "");
    setHousePhotos(sub.houseMoveInPhotoDataUrls ?? []);
    setHouseVideo(sub.houseMoveInVideoDataUrl ?? null);
    setEditingTarget((current) => {
      if (!current || current === HOUSE_MOVE_IN_TARGET_ID) return current;
      return sub.rooms.some((room) => room.id === current) ? current : null;
    });
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
      (draft.moveInInstructions ?? "") !== (room.moveInInstructions ?? "") ||
      !roomMediaMatches(draft, room)
    );
  };

  const saveRoom = (room: ManagerRoomSubmission) => {
    const draft = roomDraft(room);
    const ok = persistSubmission(
      {
        ...sub,
        rooms: sub.rooms.map((r) =>
          r.id === room.id
            ? {
                ...r,
                moveInInstructions: draft.moveInInstructions ?? "",
                moveInAvailableDate: r.moveInAvailableDate ?? "",
                moveInPhotoDataUrls: [...(draft.moveInPhotoDataUrls ?? [])],
                moveInVideoDataUrl: draft.moveInVideoDataUrl ?? null,
              }
            : r,
        ),
      },
      "Move-in details saved.",
    );
    if (ok) setEditingTarget(null);
  };

  const houseDirty =
    houseInstructions !== (sub.houseMoveInInstructions ?? "") ||
    housePhotos.join("|") !== (sub.houseMoveInPhotoDataUrls ?? []).join("|") ||
    (houseVideo ?? null) !== (sub.houseMoveInVideoDataUrl ?? null);

  const saveHouse = () => {
    const ok = persistSubmission(
      {
        ...sub,
        houseMoveInInstructions: houseInstructions,
        houseMoveInAvailableDate: sub.houseMoveInAvailableDate ?? "",
        houseMoveInPhotoDataUrls: [...housePhotos],
        houseMoveInVideoDataUrl: houseVideo,
      },
      "Move-in details saved.",
    );
    if (ok) setEditingTarget(null);
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

  const toggleHouseSelected = () => {
    setHouseSelected((current) => !current);
  };

  const openEditor = (target: MoveInEditTarget) => {
    setEditingTarget(target);
    setSelectedRoomIds([]);
    setHouseSelected(false);
  };

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
    if (ok) {
      setSelectedRoomIds([]);
      setHouseSelected(false);
    }
    setCopyingToRooms(false);
  };

  const handleBulkEdit = () => {
    if (houseSelected && selectedRoomIds.length === 0) {
      openEditor(HOUSE_MOVE_IN_TARGET_ID);
      return;
    }
    if (selectedRoomIds.length === 1 && !houseSelected) {
      openEditor(selectedRoomIds[0]!);
      return;
    }
    copyHouseToSelectedRooms();
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

  // Back is the editor's only exit and it saves on the way out, so a failed
  // save (the payload carries photo/video data URLs, and local storage has a
  // quota) left the manager with no way out at all. Discard resets the draft
  // from the saved submission and leaves.
  const discardMoveInEdits = () => {
    setDraftByRoomId(Object.fromEntries(sub.rooms.map((room) => [room.id, room])));
    setHouseInstructions(sub.houseMoveInInstructions ?? "");
    setHousePhotos(sub.houseMoveInPhotoDataUrls ?? []);
    setHouseVideo(sub.houseMoveInVideoDataUrl ?? null);
    setEditingTarget(null);
  };

  const renderMoveInEditor = ({
    title,
    subtitle,
    instructions,
    photoDataUrls,
    videoDataUrl,
    dirty,
    onInstructionsChange,
    onPhotosChange,
    onVideoChange,
    onSave,
  }: {
    title: string;
    subtitle?: string;
    instructions: string;
    photoDataUrls: string[];
    videoDataUrl: string | null;
    dirty: boolean;
    onInstructionsChange: (value: string) => void;
    onPhotosChange: (urls: string[]) => void;
    onVideoChange: (url: string | null) => void;
    onSave: () => void;
  }) => (
    <PortalPropertyDetailSection>
      <PortalDetailHeader
        bare
        title={title}
        subtitle={subtitle}
        hideBackText
        onBack={() => {
          if (canEdit && dirty) {
            onSave();
            return;
          }
          setEditingTarget(null);
        }}
        dataAttrBack="property-move-in-editor-back"
      />
      {canEdit && dirty ? (
        <div className="flex justify-end px-1 pt-2">
          <Button
            type="button"
            variant="ghost"
            className="h-9 min-h-0 px-3 text-[13px]"
            data-attr="property-move-in-editor-discard"
            onClick={discardMoveInEdits}
          >
            Discard changes
          </Button>
        </div>
      ) : null}
      <div className="px-1 pt-4">
        <MoveInInstructionsField
          moveInInstructions={instructions}
          disabled={!canEdit}
          onInstructionsChange={onInstructionsChange}
        />
        <MoveInMediaFields
          photoDataUrls={photoDataUrls}
          videoDataUrl={videoDataUrl}
          disabled={!canEdit}
          onPhotosChange={onPhotosChange}
          onVideoChange={onVideoChange}
          onError={showToast}
        />
      </div>
    </PortalPropertyDetailSection>
  );

  if (editingTarget === HOUSE_MOVE_IN_TARGET_ID) {
    return renderMoveInEditor({
      title: "The whole house",
      subtitle: entireHome
        ? "Whole-home move-in details shown to placed residents."
        : "Shown to every resident here, whichever room they take.",
      instructions: houseInstructions,
      photoDataUrls: housePhotos,
      videoDataUrl: houseVideo,
      dirty: houseDirty,
      onInstructionsChange: setHouseInstructions,
      onPhotosChange: setHousePhotos,
      onVideoChange: setHouseVideo,
      onSave: saveHouse,
    });
  }

  if (editingTarget && editingTarget !== HOUSE_MOVE_IN_TARGET_ID) {
    const room = sub.rooms.find((r) => r.id === editingTarget);
    if (!room) {
      setEditingTarget(null);
      return null;
    }
    const draft = roomDraft(room);
    const index = sub.rooms.findIndex((r) => r.id === room.id);
    const label = room.name.trim() || `Room ${index + 1}`;
    return renderMoveInEditor({
      title: label,
      subtitle: room.floor.trim() || undefined,
      instructions: draft.moveInInstructions ?? "",
      photoDataUrls: draft.moveInPhotoDataUrls ?? [],
      videoDataUrl: draft.moveInVideoDataUrl ?? null,
      dirty: roomDirty(room),
      onInstructionsChange: (value) =>
        setDraftByRoomId((prev) => ({
          ...prev,
          [room.id]: { ...draft, moveInInstructions: value },
        })),
      onPhotosChange: (urls) =>
        setDraftByRoomId((prev) => ({
          ...prev,
          [room.id]: { ...draft, moveInPhotoDataUrls: urls },
        })),
      onVideoChange: (url) =>
        setDraftByRoomId((prev) => ({
          ...prev,
          [room.id]: { ...draft, moveInVideoDataUrl: url },
        })),
      onSave: () => saveRoom(room),
    });
  }

  if (entireHome) {
    return (
      <PortalPropertyDetailSection>
        <p className="mb-3 px-1 text-sm text-muted">Whole-home move-in details shown to placed residents.</p>
        <div className="divide-y divide-border/50">
          <div className="px-1">
            <button
              type="button"
              data-attr="property-move-in-house"
              className={cn(
                PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS,
                "flex w-full cursor-pointer items-start gap-2.5 rounded-lg text-left transition hover:bg-accent/20",
              )}
              onClick={() => openEditor(HOUSE_MOVE_IN_TARGET_ID)}
              onDoubleClick={() => openEditor(HOUSE_MOVE_IN_TARGET_ID)}
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">The whole house</p>
                <p className="mt-0.5 text-xs text-muted">{houseMoveInSummary(sub)}</p>
              </div>
            </button>
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

  const houseRowDirty = houseDirty;
  const bulkEditOpensEditor =
    (houseSelected && selectedRoomIds.length === 0) ||
    (selectedRoomIds.length === 1 && !houseSelected);
  const bulkEditCopiesToRooms = selectedRoomIds.length > 0 && !bulkEditOpensEditor;
  const bulkEditDisabled = copyingToRooms || (bulkEditCopiesToRooms && !houseHasSavedDetails);
  const bulkEditLabel = copyingToRooms ? "Applying…" : bulkEditOpensEditor ? "Edit" : "Copy house details";

  return (
    <>
      <PortalPropertyDetailSection>
        <p className="mb-3 px-1 text-sm text-muted">
          Set shared house details (front door code, parking, bins) for every resident. Tick individual rooms to copy
          saved house details into them, or open a row to edit move-in instructions, photos, and video.
        </p>
        <div className="divide-y divide-border/50">
          <div className="px-1">
            <div
              className={cn(
                PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS,
                "flex items-start gap-2.5 rounded-lg transition",
                houseSelected ? "border-l-2 border-l-primary bg-primary/5" : "hover:bg-accent/20",
              )}
            >
              {canEdit ? (
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 shrink-0 rounded border-border accent-primary"
                  checked={houseSelected}
                  aria-label="Select the whole house"
                  data-attr="property-move-in-house-select"
                  onChange={toggleHouseSelected}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : null}
              <button
                type="button"
                data-attr="property-move-in-house"
                className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 text-left"
                onClick={() => openEditor(HOUSE_MOVE_IN_TARGET_ID)}
                onDoubleClick={() => openEditor(HOUSE_MOVE_IN_TARGET_ID)}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-foreground">The whole house</p>
                    {houseRowDirty ? (
                      <Badge tone="neutral" className="text-[10px] font-semibold uppercase tracking-wide">
                        Draft
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-xs text-muted">
                    Shown to every resident · {houseMoveInSummary(sub)}
                  </p>
                </div>
              </button>
            </div>
          </div>

          {roomIndices.map((index) => {
            const room = sub.rooms[index]!;
            const label = room.name.trim() || `Room ${index + 1}`;
            const checked = selectedRoomIds.includes(room.id);
            const draft = roomDraft(room);
            const dirty = roomDirty(room);

            return (
              <div key={room.id} className="px-1">
                <div
                  className={cn(
                    PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS,
                    "flex items-start gap-2.5 rounded-lg transition",
                    checked ? "border-l-2 border-l-primary bg-primary/5" : "hover:bg-accent/20",
                  )}
                >
                  {canEdit ? (
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 shrink-0 rounded border-border accent-primary"
                      checked={checked}
                      aria-label={`Select ${label}`}
                      data-attr={`property-move-in-room-select-${room.id}`}
                      onChange={() => toggleRoomSelected(room.id)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : null}
                  <button
                    type="button"
                    data-attr={`property-move-in-room-${room.id}`}
                    className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 text-left"
                    onClick={() => openEditor(room.id)}
                    onDoubleClick={() => openEditor(room.id)}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-foreground">{label}</p>
                        {dirty ? (
                          <Badge tone="neutral" className="text-[10px] font-semibold uppercase tracking-wide">
                            Draft
                          </Badge>
                        ) : null}
                      </div>
                      <p className="mt-0.5 text-xs text-muted">
                        {[room.floor.trim() || null, roomMoveInSummary(draft)].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </PortalPropertyDetailSection>

      {selectionActive ? (
        <BulkActionBar count={selectionCount} hideCount variant="payments">
          <div className="flex min-w-0 flex-wrap items-center justify-start gap-2">
            <Button
              type="button"
              variant="outline"
              className={PORTAL_BULK_BAR_BTN}
              data-attr="property-move-in-bulk-edit"
              disabled={bulkEditDisabled}
              onClick={handleBulkEdit}
            >
              {bulkEditLabel}
            </Button>
            <Button
              type="button"
              variant="primary"
              className={PORTAL_BULK_BAR_BTN}
              data-attr="property-move-in-share"
              onClick={() => void handleShareMoveIn()}
            >
              Share
            </Button>
          </div>
        </BulkActionBar>
      ) : null}
    </>
  );
}
