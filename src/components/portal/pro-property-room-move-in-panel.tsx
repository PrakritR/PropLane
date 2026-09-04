"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BulkActionBar } from "@/components/ui/bulk-action-bar";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/input";
import {
  PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS,
  PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS,
  PortalPropertyDetailSection,
} from "@/components/portal/portal-property-detail-section";
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
  const [expandedRoomId, setExpandedRoomId] = useState<string | null>(null);
  const [draftByRoomId, setDraftByRoomId] = useState<Record<string, ManagerRoomSubmission>>({});
  const [houseInstructions, setHouseInstructions] = useState(sub.houseMoveInInstructions ?? "");
  const [housePhotos, setHousePhotos] = useState(sub.houseMoveInPhotoDataUrls ?? []);
  const [houseVideo, setHouseVideo] = useState(sub.houseMoveInVideoDataUrl ?? null);
  const [savingRoomId, setSavingRoomId] = useState<string | null>(null);
  const [savingHouse, setSavingHouse] = useState(false);
  const [selectedRoomIds, setSelectedRoomIds] = useState<string[]>([]);
  const [copyingToRooms, setCopyingToRooms] = useState(false);

  const selectionActive = selectedRoomIds.length > 0;

  useEffect(() => {
    setDraftByRoomId(Object.fromEntries(sub.rooms.map((room) => [room.id, room])));
    setHouseInstructions(sub.houseMoveInInstructions ?? "");
    setHousePhotos(sub.houseMoveInPhotoDataUrls ?? []);
    setHouseVideo(sub.houseMoveInVideoDataUrl ?? null);
    setExpandedRoomId((current) =>
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

  const toggleRoomExpanded = (roomId: string) => {
    setExpandedRoomId((current) => (current === roomId ? null : roomId));
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
    if (ok) setSelectedRoomIds([]);
    setCopyingToRooms(false);
  };

  const handleBulkEdit = () => {
    if (selectedRoomIds.length === 1) {
      const roomId = selectedRoomIds[0]!;
      setExpandedRoomId(roomId);
      setSelectedRoomIds([]);
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

  if (entireHome) {
    return (
      <PortalPropertyDetailSection
        actions={
          canEdit && !selectionActive ? (
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
          <p className="text-sm text-muted">Whole-home move-in details shown to placed residents.</p>
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

  return (
    <>
      <PortalPropertyDetailSection
        actions={
          canEdit && !selectionActive ? (
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
          <p className="text-sm font-semibold text-foreground">The whole house</p>
          <p className="mt-0.5 text-sm text-muted">Shown to every resident here, whichever room they take.</p>
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
          Then anything specific to a room. Tick rooms to copy the house details into them, or open a room to edit
          inline.
        </p>
        <div className="divide-y divide-border/50">
          {roomIndices.map((index) => {
            const room = sub.rooms[index]!;
            const label = room.name.trim() || `Room ${index + 1}`;
            const checked = selectedRoomIds.includes(room.id);
            const expanded = expandedRoomId === room.id;
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
                      className="mt-1 h-4 w-4 shrink-0 rounded border-border"
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
                    aria-expanded={expanded}
                    onClick={() => toggleRoomExpanded(room.id)}
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
                        {[room.floor.trim() || null, roomMoveInSummary(room)].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                    {expanded ? (
                      <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
                    ) : (
                      <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
                    )}
                  </button>
                </div>

                {expanded ? (
                  <div className="border-l-2 border-l-primary/40 bg-primary/[0.03] px-3 py-4 sm:px-4">
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
                    {canEdit && !selectionActive ? (
                      <div className="mt-4 flex justify-end">
                        <Button
                          type="button"
                          variant="primary"
                          className={PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS}
                          data-attr="room-move-in-save"
                          data-testid="room-move-in-save"
                          disabled={!dirty || savingRoomId === room.id}
                          onClick={() => saveRoom(room)}
                        >
                          {savingRoomId === room.id ? "Saving…" : "Save"}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </PortalPropertyDetailSection>

      <BulkActionBar count={selectedRoomIds.length} hideCount variant="payments">
        <Button
          type="button"
          variant="outline"
          className="h-9 min-h-0 rounded-full px-4 text-[13px]"
          onClick={() => setSelectedRoomIds([])}
        >
          Clear
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-9 min-h-0 rounded-full px-4 text-[13px]"
          data-attr="property-move-in-bulk-edit"
          disabled={copyingToRooms || (selectedRoomIds.length > 1 && !houseHasSavedDetails)}
          onClick={handleBulkEdit}
        >
          {selectedRoomIds.length > 1 && copyingToRooms ? "Applying…" : "Edit"}
        </Button>
        <Button
          type="button"
          variant="primary"
          className="h-9 min-h-0 rounded-full px-4 text-[13px]"
          data-attr="property-move-in-share"
          onClick={() => void handleShareMoveIn()}
        >
          Share
        </Button>
      </BulkActionBar>
    </>
  );
}
