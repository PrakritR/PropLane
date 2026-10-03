"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { DoorOpen, FileText, Home, Image as ImageIcon, KeyRound, Settings, Users, Video, Wifi } from "lucide-react";
import { Textarea } from "@/components/ui/input";
import { MoveInMediaFields } from "@/components/portal/move-in-media-fields";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalPropertyDetailSection } from "@/components/portal/portal-property-detail-section";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPropertyRecordRow, PortalRowFact, PortalRowIconTile } from "@/components/portal/portal-record-row";
import { RowActionsMenu, type RowAction } from "@/components/portal/row-actions-menu";
import { roomMoveInClipboardText, roomMoveInShareUrl } from "@/lib/move-in-share";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import {
  PropertyMoveInEditorModal,
  type MoveInEditorTarget,
} from "@/components/portal/property-move-in-editor-modal";
import { PropertySectionPreviewModal } from "@/components/portal/property-section-preview-modal";
import { MoveInResidentPreviewCard } from "@/components/portal/move-in-resident-preview-card";
import { getHouseInfoValue, normalizeHouseInfo, type HouseInfoV1 } from "@/lib/house-info";
import { PortalPropertySectionSettingsModal } from "@/components/portal/portal-property-section-settings-modal";
import { updateRequestChangeProperty } from "@/lib/demo-admin-property-inventory";
import {
  updateExtraListingFromSubmission,
  updatePendingManagerProperty,
} from "@/lib/demo-property-pipeline";
import type { ManagerListingSubmissionV1, ManagerRoomResidentMoveIn, ManagerRoomSubmission } from "@/lib/manager-listing-submission";
import { isEntireHomeListing, reconcileRoomResidentMoveIn } from "@/lib/manager-listing-submission";
import { sortRoomIndicesByFloor } from "@/lib/listing-floor-order";
import { moveInFactTexts } from "@/lib/property-record-row-facts";

type RoomSaveTarget =
  | { mode: "pending"; saveId: string }
  | { mode: "listing"; saveId: string }
  | { mode: "requestChange"; saveId: string }
  | null;

function residentMoveInShareUrl(): string {
  if (typeof window === "undefined") return "/resident/move-in";
  return `${window.location.origin}/resident/move-in`;
}

export function MoveInCardFields({
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
  propertyLabel,
  onAddResident,
}: {
  sub: ManagerListingSubmissionV1;
  saveTarget: RoomSaveTarget;
  managerUserId: string | null;
  canEdit: boolean;
  onUpdated: () => void;
  showToast: (message: string) => void;
  /** For the Settings gear's "Applies to" row (S016). */
  propertyLabel?: string;
  /** The round blue + (studio: "Add resident"). Omitted = no + (nothing to open it). */
  onAddResident?: () => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const entireHome = isEntireHomeListing(sub);
  const roomIndices = useMemo(() => sortRoomIndicesByFloor(sub.rooms), [sub.rooms]);

  const [houseInstructions, setHouseInstructions] = useState(sub.houseMoveInInstructions ?? "");
  const [housePhotos, setHousePhotos] = useState(sub.houseMoveInPhotoDataUrls ?? []);
  const [houseVideo, setHouseVideo] = useState(sub.houseMoveInVideoDataUrl ?? null);
  const [copyingToRooms, setCopyingToRooms] = useState(false);
  const [moveTab, setMoveTab] = useState<"house" | "rooms">("house");
  const [moveQuery, setMoveQuery] = useState("");
  const [moveEditorOpen, setMoveEditorOpen] = useState(false);
  const [moveEditorTarget, setMoveEditorTarget] = useState<MoveInEditorTarget | null>(null);
  const [houseInfoDraft, setHouseInfoDraft] = useState<HouseInfoV1>(() => normalizeHouseInfo(sub.houseInfo));
  const [moveSaving, setMoveSaving] = useState(false);
  const [movePreview, setMovePreview] = useState<MoveInEditorTarget | null>(null);

  useEffect(() => {
    setHouseInstructions(sub.houseMoveInInstructions ?? "");
    setHousePhotos(sub.houseMoveInPhotoDataUrls ?? []);
    setHouseVideo(sub.houseMoveInVideoDataUrl ?? null);
    setHouseInfoDraft(normalizeHouseInfo(sub.houseInfo));
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
  const activeMoveTab = showRooms ? moveTab : "house";

  const openMoveEditor = (target: MoveInEditorTarget) => {
    setMoveEditorTarget(target);
    setMoveEditorOpen(true);
  };

  /** Plain text of the row's fact line — also what the search matches against. */
  const moveRowFactTexts = (instructions: string, photos: string[], video: string | null, withHouseAccess = false) => {
    const t = moveInFactTexts({ instructions, photoCount: photos.length, hasVideo: Boolean(video) });
    const out: { key: string; icon: typeof FileText; text: string }[] = [
      { key: "instructions", icon: FileText, text: t.instructions },
      { key: "photos", icon: ImageIcon, text: t.photos },
      { key: "video", icon: Video, text: t.video },
    ];
    if (withHouseAccess) {
      if (getHouseInfoValue(houseInfoDraft, "access", "doorCode").trim()) out.push({ key: "door", icon: KeyRound, text: "Door code" });
      if (getHouseInfoValue(houseInfoDraft, "wifi", "wifiNetwork").trim()) out.push({ key: "wifi", icon: Wifi, text: "Wi-Fi" });
    }
    return out;
  };
  const moveRowSummary = (instructions: string, photos: string[], video: string | null, withHouseAccess = false) =>
    moveRowFactTexts(instructions, photos, video, withHouseAccess)
      .map((f) => f.text)
      .join(" · ");
  const moveRowFacts = (instructions: string, photos: string[], video: string | null, withHouseAccess = false) =>
    moveRowFactTexts(instructions, photos, video, withHouseAccess).map((f) => (
      <PortalRowFact key={f.key} icon={f.icon}>
        {f.text}
      </PortalRowFact>
    ));

  const moveMatches = (text: string) =>
    !moveQuery.trim() || text.toLowerCase().includes(moveQuery.trim().toLowerCase());

  const houseRowSummary = moveRowSummary(houseInstructions, housePhotos, houseVideo, true);
  const houseRowVisible = moveMatches(`The whole house ${houseRowSummary}`);

  const movePreviewCard = (target: MoveInEditorTarget) => {
    const label = propertyLabel?.trim() || "Property";
    if (target.kind === "house") {
      return (
        <MoveInResidentPreviewCard
          propertyLabel={label}
          title="The whole house"
          instructions={houseInstructions}
          photoDataUrls={housePhotos}
          videoDataUrl={houseVideo}
          houseInfo={houseInfoDraft}
          showWholeHouseAccess
        />
      );
    }
    const room = sub.rooms.find((r) => r.id === target.roomId);
    const roomTitle = room?.name.trim() || "Room";
    if (target.kind === "roomResident") {
      const entry = room?.moveInResidentDetails?.[target.slotIndex];
      return (
        <MoveInResidentPreviewCard
          propertyLabel={label}
          title={`${roomTitle} · Resident ${target.slotIndex + 1}`}
          instructions={entry?.moveInInstructions ?? ""}
          photoDataUrls={entry?.moveInPhotoDataUrls ?? []}
          videoDataUrl={entry?.moveInVideoDataUrl ?? null}
        />
      );
    }
    return (
      <MoveInResidentPreviewCard
        propertyLabel={label}
        title={roomTitle}
        instructions={room?.moveInInstructions ?? ""}
        photoDataUrls={room?.moveInPhotoDataUrls ?? []}
        videoDataUrl={room?.moveInVideoDataUrl ?? null}
      />
    );
  };

  /** "Saved details" is what is on the SAVED room, never an unsaved draft — same rule as the house section. */
  const roomHasSavedDetails = (room: ManagerRoomSubmission) =>
    Boolean(room.moveInInstructions?.trim()) ||
    (room.moveInPhotoDataUrls?.length ?? 0) > 0 ||
    Boolean(room.moveInVideoDataUrl);

  const copyRoomMoveIn = (room: ManagerRoomSubmission, label: string) => {
    const text = roomMoveInClipboardText({
      roomLabel: label,
      instructions: room.moveInInstructions ?? "",
      photoCount: (room.moveInPhotoDataUrls ?? []).length,
      hasVideo: Boolean(room.moveInVideoDataUrl),
      residents: (room.moveInResidentDetails ?? []).map((entry, i) => ({
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

  const shareRoomMoveIn = (room: ManagerRoomSubmission, label: string) => {
    const url = typeof window === "undefined" ? "/resident/move-in/info" : roomMoveInShareUrl(window.location.origin, room.id);
    void navigator.clipboard.writeText(url).then(
      () => showToast(`${label} move-in link copied.`),
      () => showToast(url),
    );
  };

  /** One ⋯ per row, Edit first (ui-page-structure.md). A room row also keeps its Copy and Share. */
  const moveRowMenu = (rowLabel: string, target: MoveInEditorTarget, extra: RowAction[] = []) => (
    <RowActionsMenu
      label={rowLabel}
      items={[
        { id: "edit", label: "Edit", onSelect: () => openMoveEditor(target) },
        { id: "preview", label: "Preview", onSelect: () => setMovePreview(target) },
        ...extra,
      ]}
    />
  );

  const roomMenuExtras = (room: ManagerRoomSubmission, label: string): RowAction[] => [
    { id: "copy", label: "Copy move-in info", disabled: !roomHasSavedDetails(room), onSelect: () => copyRoomMoveIn(room, label) },
    { id: "share", label: "Share move-in link", onSelect: () => shareRoomMoveIn(room, label) },
  ];

  const saveMoveHouse = (payload: {
    houseInfo: HouseInfoV1;
    instructions: string;
    photos: string[];
    video: string | null;
  }) => {
    setMoveSaving(true);
    const ok = persistSubmission(
      {
        ...sub,
        houseInfo: payload.houseInfo,
        houseMoveInInstructions: payload.instructions,
        houseMoveInAvailableDate: sub.houseMoveInAvailableDate ?? "",
        houseMoveInPhotoDataUrls: [...payload.photos],
        houseMoveInVideoDataUrl: payload.video,
      },
      "Move-in details saved.",
    );
    setMoveSaving(false);
    if (ok) {
      setHouseInstructions(payload.instructions);
      setHousePhotos(payload.photos);
      setHouseVideo(payload.video);
      setHouseInfoDraft(payload.houseInfo);
      setMoveEditorOpen(false);
    }
  };

  const saveMoveRoomResident = (roomId: string, slotIndex: number, entry: ManagerRoomResidentMoveIn) => {
    const room = sub.rooms.find((r) => r.id === roomId);
    if (!room) return;
    setMoveSaving(true);
    const rows = [...(room.moveInResidentDetails ?? [])];
    while (rows.length <= slotIndex) {
      rows.push({ moveInInstructions: "", moveInPhotoDataUrls: [], moveInVideoDataUrl: null });
    }
    rows[slotIndex] = entry;
    const ok = persistSubmission(
      {
        ...sub,
        rooms: sub.rooms.map((row) =>
          row.id === roomId ? reconcileRoomResidentMoveIn({ ...row, moveInResidentDetails: rows }) : row,
        ),
      },
      "Move-in details saved.",
    );
    setMoveSaving(false);
    if (ok) setMoveEditorOpen(false);
  };

  const saveMoveRoom = (roomId: string, patch: Partial<ManagerRoomSubmission>) => {
    const room = sub.rooms.find((r) => r.id === roomId);
    if (!room) return;
    setMoveSaving(true);
    const draft = { ...room, ...patch };
    const ok = persistSubmission(
      {
        ...sub,
        rooms: sub.rooms.map((row) =>
          row.id === roomId
            ? reconcileRoomResidentMoveIn({
                ...row,
                moveInInstructions: draft.moveInInstructions ?? "",
                moveInAvailableDate: row.moveInAvailableDate ?? "",
                moveInPhotoDataUrls: [...(draft.moveInPhotoDataUrls ?? [])],
                moveInVideoDataUrl: draft.moveInVideoDataUrl ?? null,
              })
            : row,
        ),
      },
      "Move-in details saved.",
    );
    setMoveSaving(false);
    if (ok) setMoveEditorOpen(false);
  };

  return (
    <PortalPropertyDetailSection>
      <PortalPropertySectionSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Move-in settings"
        propertyLabel={propertyLabel ?? "This property"}
        dataAttr="property-move-in-settings"
      >
        {/* Nothing here is stored per property yet (no `operationsSettings`
            namespace or submission field backs a move-in checklist or house
            rules addendum toggle) — an honest empty settings surface rather
            than a fabricated one (S016: "leave it out — no new schema"). */}
        <p className="text-sm text-muted">Nothing to configure for Move-in yet.</p>
      </PortalPropertySectionSettingsModal>
      <div className="space-y-2" data-attr="property-move-in-list">
        <PortalRecordListSurface
          listControls={
            <PortalListControlStack
              variant="command"
              destinationRow={
                showRooms ? (
                  <LocalDestinationNav
                    items={[
                      { id: "house", label: "Whole house", count: 1 },
                      { id: "rooms", label: "Rooms", count: sub.rooms.length },
                    ]}
                    activeId={activeMoveTab}
                    onChange={(id) => setMoveTab(id as "house" | "rooms")}
                    ariaLabel="Move-in"
                    appearance="command"
                  />
                ) : undefined
              }
              activeDestinationId={activeMoveTab}
              destinationAriaLabel="Move-in"
              search={{
                value: moveQuery,
                onChange: setMoveQuery,
                placeholder: "Search move-in",
                ariaLabel: "Search move-in",
                dataAttr: "property-move-in-search",
              }}
              actions={
                <>
                  <PortalIconAction
                    icon={Settings}
                    label="Move-in settings"
                    data-attr="property-move-in-settings-open"
                    onClick={() => setSettingsOpen(true)}
                  />
                </>
              }
              primary={
                canEdit && onAddResident ? (
                  <PortalPrimaryIconAction label="Add resident" data-attr="property-move-in-add-resident" onClick={onAddResident} />
                ) : undefined
              }
            />
          }
          isEmpty={
            Boolean(moveQuery.trim()) &&
            ((activeMoveTab === "house" && !houseRowVisible) ||
              (activeMoveTab === "rooms" &&
                roomIndices.every((index) => {
                  const room = sub.rooms[index]!;
                  const label = room.name.trim() || `Room ${index + 1}`;
                  const summary = moveRowSummary(
                    room.moveInInstructions ?? "",
                    room.moveInPhotoDataUrls ?? [],
                    room.moveInVideoDataUrl ?? null,
                  );
                  const capacity = room.occupancyCapacity ?? 1;
                  const roomHit = moveMatches(`${label} ${summary}`);
                  if (roomHit) return false;
                  if (capacity < 2) return true;
                  for (let slot = 0; slot < capacity; slot += 1) {
                    const entry = room.moveInResidentDetails?.[slot];
                    const residentLabel = `${label} · Resident ${slot + 1}`;
                    const residentSummary = moveRowSummary(
                      entry?.moveInInstructions ?? "",
                      entry?.moveInPhotoDataUrls ?? [],
                      entry?.moveInVideoDataUrl ?? null,
                    );
                    if (moveMatches(`${residentLabel} ${residentSummary}`)) return false;
                  }
                  return true;
                })))
          }
          emptyCard={
            moveQuery.trim()
              ? {
                  title: "No matches",
                  section: "move-in",
                  tone: "muted",
                  clear: { label: "Clear search", onClick: () => setMoveQuery(""), dataAttr: "property-move-in-search-clear" },
                }
              : undefined
          }
        >
          {activeMoveTab === "house" && houseRowVisible ? (
            <PortalPropertyRecordRow
              title="The whole house"
              leading={<PortalRowIconTile icon={Home} />}
              leadingShape="square"
              facts={moveRowFacts(houseInstructions, housePhotos, houseVideo, true)}
              onOpen={() => openMoveEditor({ kind: "house" })}
              dataAttr="property-move-in-house-row"
              // Studio: the header holds only the gear and the +; the house-wide Copy
              // and Share live in this row's ⋯.
              actions={moveRowMenu(
                "The whole house",
                { kind: "house" },
                canEdit && showRooms
                  ? [
                      { id: "copy-to-rooms", label: "Copy house details to rooms", disabled: !houseHasSavedDetails || copyingToRooms, onSelect: copyHouseToRooms, dataAttr: "property-move-in-copy" },
                      { id: "share", label: "Share house details", onSelect: () => void handleShareMoveIn(), dataAttr: "property-move-in-share" },
                    ]
                  : [],
              )}
            />
          ) : null}

          {activeMoveTab === "rooms"
            ? roomIndices.flatMap((index) => {
                const room = sub.rooms[index]!;
                const label = room.name.trim() || `Room ${index + 1}`;
                const capacity = room.occupancyCapacity ?? 1;
                const roomSummary = moveRowSummary(
                  room.moveInInstructions ?? "",
                  room.moveInPhotoDataUrls ?? [],
                  room.moveInVideoDataUrl ?? null,
                );
                const roomRows: ReactNode[] = moveMatches(`${label} ${roomSummary}`) ? [
                  <PortalPropertyRecordRow
                    key={room.id}
                    title={label}
                    leading={<PortalRowIconTile icon={DoorOpen} />}
                    leadingShape="square"
                    facts={moveRowFacts(
                      room.moveInInstructions ?? "",
                      room.moveInPhotoDataUrls ?? [],
                      room.moveInVideoDataUrl ?? null,
                    )}
                    onOpen={() => openMoveEditor({ kind: "room", roomId: room.id })}
                    dataAttr={`property-move-in-room-row-${room.id}`}
                    actions={moveRowMenu(label, { kind: "room", roomId: room.id }, roomMenuExtras(room, label))}
                  />,
                ] : [];
                const residentRows: ReactNode[] = capacity >= 2
                  ? Array.from({ length: capacity }, (_, slot) => {
                    const entry = room.moveInResidentDetails?.[slot];
                    const residentLabel = `${label} · Resident ${slot + 1}`;
                    const residentSummary = moveRowSummary(
                      entry?.moveInInstructions ?? "",
                      entry?.moveInPhotoDataUrls ?? [],
                      entry?.moveInVideoDataUrl ?? null,
                    );
                    if (!moveMatches(`${residentLabel} ${residentSummary}`)) return null;
                    return (
                      <PortalPropertyRecordRow
                        key={`${room.id}-resident-${slot}`}
                        title={residentLabel}
                        leading={<PortalRowIconTile icon={Users} />}
                        leadingShape="square"
                        facts={moveRowFacts(
                          entry?.moveInInstructions ?? "",
                          entry?.moveInPhotoDataUrls ?? [],
                          entry?.moveInVideoDataUrl ?? null,
                        )}
                        onOpen={() => openMoveEditor({ kind: "roomResident", roomId: room.id, slotIndex: slot })}
                        dataAttr={`property-move-in-resident-row-${room.id}-${slot}`}
                        actions={moveRowMenu(residentLabel, { kind: "roomResident", roomId: room.id, slotIndex: slot })}
                      />
                    );
                  }).filter(Boolean)
                  : [];
                return [...roomRows, ...residentRows];
              })
            : null}
        </PortalRecordListSurface>

        <PropertySectionPreviewModal
          open={movePreview !== null}
          title={
            movePreview?.kind === "house"
              ? "The whole house"
              : movePreview?.kind === "roomResident"
                ? `${sub.rooms.find((r) => r.id === movePreview.roomId)?.name.trim() || "Room"} · Resident ${movePreview.slotIndex + 1}`
                : sub.rooms.find((r) => r.id === movePreview?.roomId)?.name.trim() || "Room"
          }
          onClose={() => setMovePreview(null)}
          onEdit={() => {
            if (!movePreview) return;
            openMoveEditor(movePreview);
            setMovePreview(null);
          }}
        >
          {movePreview ? movePreviewCard(movePreview) : null}
        </PropertySectionPreviewModal>

        <PropertyMoveInEditorModal
          open={moveEditorOpen}
          target={moveEditorTarget}
          houseInfo={houseInfoDraft}
          houseInstructions={houseInstructions}
          housePhotos={housePhotos}
          houseVideo={houseVideo}
          room={
            moveEditorTarget?.kind === "room" || moveEditorTarget?.kind === "roomResident"
              ? sub.rooms.find((r) => r.id === moveEditorTarget.roomId) ?? null
              : null
          }
          onClose={() => setMoveEditorOpen(false)}
          onSaveHouse={saveMoveHouse}
          onSaveRoom={saveMoveRoom}
          onSaveRoomResident={saveMoveRoomResident}
          busy={moveSaving}
          canEdit={canEdit}
          onError={showToast}
        />
      </div>
    </PortalPropertyDetailSection>
  );
}
