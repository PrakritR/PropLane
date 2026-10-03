"use client";

import { useCallback, useMemo, useState } from "react";
import {
  Bath,
  BedDouble,
  Building2,
  CalendarDays,
  CircleCheck,
  CircleSlash,
  DoorOpen,
  Eye,
  FileText,
  Home,
  Layers,
  Lock,
  MapPin,
  Ruler,
  ShieldCheck,
  Sparkles,
  User,
  Users,
  type LucideIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPropertyRecordRow, PortalRowFact, PortalRowIconTile } from "@/components/portal/portal-record-row";
import { RowActionsMenu } from "@/components/portal/row-actions-menu";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import {
  PropertyHouseDetailsEditorModal,
  type HouseDetailsEditorTarget,
} from "@/components/portal/property-house-details-editor-modal";
import { HousePrintablesCard } from "@/components/portal/house-printables-card";
import {
  HOUSE_INFO_SECTIONS,
  houseInfoRenderSections,
  houseInfoResidentsReadTabSections,
  houseInfoSectionSummaryLine,
  type HouseInfoSectionSpec,
  type HouseInfoV1,
} from "@/lib/house-info";
import { PropertySectionPreviewModal } from "@/components/portal/property-section-preview-modal";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { bathAccessOf, bathFactLabel, roomBathroomState, usersOfBath } from "@/lib/listing-room-editor/bathroom-link";
import { countWord, roomAvailabilityText, roomResidentsBedsText } from "@/lib/property-record-row-facts";
import { roomFurnitureItems, roomFurnishingLabel } from "@/lib/listing-room-editor";
import { readHouseDetailsTab, writeHouseDetailsTab, type HouseDetailsTabId } from "@/lib/property-house-details-tab";
import { sharedSpaceAccessTriggerLabel } from "@/lib/listing-shared-space-access";
import { SHARED_SPACE_KIND_OPTIONS } from "@/data/manager-listing-presets";
import {
  duplicateRoomEntry,
  duplicateSharedSpaceEntry,
  emptyBathroom,
  emptyRoom,
  emptySharedSpace,
  isEntireHomeListing,
  isRoomSlotRemovable,
  type ManagerSharedSpaceSubmission,
} from "@/lib/manager-listing-submission";
import { duplicateBathroomInSubmission } from "@/lib/listing-room-editor/bathroom-link";
import { encodeSharedSpaceEveryone } from "@/lib/listing-shared-space-access";
import {
  propertyAmenitiesSummary,
  propertyFactsSummary,
} from "@/components/portal/property-house-submission-house-tab";
import { floorLevelSelectOptions } from "@/data/manager-listing-presets";

type SavePayload = {
  sub: ManagerListingSubmissionV1;
  houseInfo: HouseInfoV1;
  managerNotes: string;
};

/** One row's fact line: glyph + short value each, empty values dropped. */
function rowFacts(list: ReadonlyArray<{ icon: LucideIcon; text: string | null | undefined; sr?: string }>) {
  return list
    .filter((f) => Boolean(f.text && f.text.trim()))
    .map((f, index) => (
      <PortalRowFact key={`${index}-${f.text}`} icon={f.icon} srLabel={f.sr}>
        {f.text}
      </PortalRowFact>
    ));
}

export function PropertyHouseDetailsListPanel({
  propertyId,
  sub,
  houseInfo,
  managerNotes,
  managerUserId,
  onPersist,
  showToast,
  earlierNotes,
}: {
  /** Legacy free-text (General house info / House rules) — a Manager tools row when present. */
  earlierNotes?: { onOpen: () => void };
  propertyId: string;
  sub: ManagerListingSubmissionV1;
  houseInfo: HouseInfoV1;
  managerNotes: string;
  managerUserId: string | null;
  onPersist: (payload: SavePayload) => boolean;
  showToast?: (message: string) => void;
}) {
  const [tab, setTab] = useState<HouseDetailsTabId>(() => readHouseDetailsTab(propertyId, "rooms"));
  const [query, setQuery] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [target, setTarget] = useState<HouseDetailsEditorTarget | null>(null);
  const [saving, setSaving] = useState(false);
  const [infoPreview, setInfoPreview] = useState<
    | { kind: "section"; spec: HouseInfoSectionSpec }
    | { kind: "other" }
    | null
  >(null);

  const wholePlace = isEntireHomeListing(sub);
  const rooms = sub.rooms ?? [];
  const baths = sub.bathrooms ?? [];
  const spaces = sub.sharedSpaces ?? [];

  const pickTab = (next: HouseDetailsTabId) => {
    setTab(next);
    writeHouseDetailsTab(propertyId, next);
  };

  const openEditor = (next: HouseDetailsEditorTarget) => {
    setTarget(next);
    setEditorOpen(true);
  };

  const residentReadSections = useMemo(
    () => houseInfoResidentsReadTabSections(houseInfo),
    [houseInfo],
  );

  const tabs = useMemo(() => {
    const infoCount = residentReadSections.length + 1;
    return [
      { id: "rooms" as const, label: "Rooms", count: rooms.length },
      { id: "baths" as const, label: "Bathrooms", count: baths.length },
      { id: "spaces" as const, label: "Shared spaces", count: spaces.length, hide: spaces.length === 0 },
      { id: "house" as const, label: "The house", count: 3 },
      { id: "info" as const, label: "Residents read this", count: infoCount },
      { id: "manager" as const, label: "Manager tools", count: 3 },
    ].filter((t) => !t.hide);
  }, [rooms.length, baths.length, spaces.length, residentReadSections.length, houseInfo]);

  const activeTab = tabs.find((t) => t.id === tab)?.id ?? tabs[0]?.id ?? "rooms";

  const matches = useCallback(
    (text: string) => !query.trim() || text.toLowerCase().includes(query.trim().toLowerCase()),
    [query],
  );

  const roomRowMenu = (roomId: string, label: string, onDuplicate: () => void, onRemove?: () => void) => (
    <RowActionsMenu
      label={label}
      items={[
        { id: "edit", label: "Edit", onSelect: () => openEditor({ kind: "room", roomId }) },
        { id: "duplicate", label: "Duplicate", onSelect: onDuplicate },
        onRemove ? { id: "delete", label: "Delete", danger: true, onSelect: onRemove } : null,
      ]}
    />
  );

  const saveEditor = (payload: SavePayload) => {
    setSaving(true);
    const ok = onPersist(payload);
    setSaving(false);
    if (!ok) {
      showToast?.("Could not save.");
      return;
    }
    showToast?.("Saved.");
    setEditorOpen(false);
  };

  const persistSub = (nextSub: ManagerListingSubmissionV1, message = "Saved.") => {
    const ok = onPersist({ sub: nextSub, houseInfo, managerNotes });
    if (ok) showToast?.(message);
    else showToast?.("Could not save.");
    return ok;
  };

  const addRoom = () => {
    const rooms = sub.rooms ?? [];
    const next = emptyRoom(rooms.length);
    if (!persistSub({ ...sub, rooms: [...rooms, next] }, "Room added.")) return;
    openEditor({ kind: "room", roomId: next.id });
  };

  const addBathroom = () => {
    const baths = sub.bathrooms ?? [];
    const next = emptyBathroom(baths.length);
    if (!persistSub({ ...sub, bathrooms: [...baths, next] }, "Bathroom added.")) return;
    openEditor({ kind: "bath", bathId: next.id });
  };

  const duplicateRoom = (roomId: string) => {
    const rooms = sub.rooms ?? [];
    const source = rooms.find((r) => r.id === roomId);
    if (!source) return;
    const copy = duplicateRoomEntry(source, { keepName: false });
    persistSub({ ...sub, rooms: [...rooms, copy] }, "Room duplicated.");
  };

  const removeRoom = (roomId: string) => {
    const rooms = sub.rooms ?? [];
    const room = rooms.find((r) => r.id === roomId);
    if (!room || rooms.length <= 1 || !isRoomSlotRemovable(room)) return;
    persistSub({ ...sub, rooms: rooms.filter((r) => r.id !== roomId) }, "Room removed.");
  };

  const duplicateBath = (bathId: string) => {
    const nextSub = duplicateBathroomInSubmission(sub, bathId);
    if (nextSub) persistSub(nextSub, "Bathroom duplicated.");
  };

  const removeBath = (bathId: string) => {
    const baths = sub.bathrooms ?? [];
    if (baths.length <= 1) return;
    persistSub({ ...sub, bathrooms: baths.filter((b) => b.id !== bathId) }, "Bathroom removed.");
  };

  const duplicateSpace = (spaceId: string) => {
    const list = sub.sharedSpaces ?? [];
    const source = list.find((s) => s.id === spaceId);
    if (!source) return;
    persistSub({ ...sub, sharedSpaces: [...list, duplicateSharedSpaceEntry(source)] }, "Shared space duplicated.");
  };

  const removeSpace = (spaceId: string) => {
    const list = sub.sharedSpaces ?? [];
    persistSub({ ...sub, sharedSpaces: list.filter((s) => s.id !== spaceId) }, "Shared space removed.");
  };

  const addSharedSpace = (kind?: ManagerSharedSpaceSubmission["spaceKind"]) => {
    const list = sub.sharedSpaces ?? [];
    const groundFloor = floorLevelSelectOptions(sub.listingStoriesId, "")[0] ?? "";
    const next = {
      ...emptySharedSpace(list.length),
      name: kind ? (SHARED_SPACE_KIND_OPTIONS.find((o) => o.id === kind)?.label ?? "") : "",
      spaceKind: kind,
      location: groundFloor,
      roomAccessIds: encodeSharedSpaceEveryone(),
    };
    if (!persistSub({ ...sub, sharedSpaces: [...list, next] }, "Shared space added.")) return;
    openEditor({ kind: "space", spaceId: next.id });
  };

  const filteredRooms = useMemo(
    () =>
      rooms.filter((room, i) => {
        const label = room.name.trim() || `Room ${i + 1}`;
        const bst = roomBathroomState(sub, room.id);
        const facts = `${label} ${bst.mode} ${roomFurnishingLabel(roomFurnitureItems(room))}`;
        return matches(facts);
      }),
    [rooms, sub, matches],
  );

  const filteredBaths = useMemo(
    () =>
      baths.filter((bath, i) => {
        const label = bath.name.trim() || `Bathroom ${i + 1}`;
        return matches(`${label} ${bath.location || ""}`);
      }),
    [baths, matches],
  );

  const filteredSpaces = useMemo(
    () =>
      spaces.filter((space, i) => {
        const label = space.name.trim() || `Shared space ${i + 1}`;
        const kind = SHARED_SPACE_KIND_OPTIONS.find((o) => o.id === space.spaceKind)?.label ?? "";
        const access = sharedSpaceAccessTriggerLabel(space.roomAccessIds, rooms.map((r) => r.id));
        return matches(`${label} ${kind} ${space.location} ${access}`);
      }),
    [spaces, rooms, matches],
  );

  const filteredInfo = useMemo(
    () =>
      residentReadSections.filter((spec) =>
        matches(`${spec.label} ${houseInfoSectionSummaryLine(houseInfo, spec)}`),
      ),
    [residentReadSections, houseInfo, matches],
  );

  const otherSummary = houseInfo.other.trim() ? "Filled in" : "Nothing added yet";
  const otherRowVisible = matches(`Anything else ${otherSummary}`);

  const tabHasRows =
    activeTab === "rooms"
      ? rooms.length > 0
      : activeTab === "baths"
        ? baths.length > 0
        : activeTab === "spaces"
          ? spaces.length > 0
          : activeTab === "info"
            ? residentReadSections.length > 0 || true
            : activeTab === "house"
              ? true
              : activeTab === "manager";

  const visibleRowCount =
    activeTab === "rooms"
      ? filteredRooms.length
      : activeTab === "baths"
        ? filteredBaths.length
        : activeTab === "spaces"
          ? filteredSpaces.length
          : activeTab === "info"
            ? filteredInfo.length + (otherRowVisible ? 1 : 0)
            : activeTab === "house"
              ? (matches("Rules") ? 1 : 0) +
                (matches(`Property facts ${propertyFactsSummary(sub)}`) ? 1 : 0) +
                (matches(`Amenities ${propertyAmenitiesSummary(sub)}`) ? 1 : 0)
              : activeTab === "manager"
                ? 1
                : 0;

  const searchNoMatches = Boolean(query.trim()) && tabHasRows && visibleRowCount === 0;

  const searchPlaceholder =
    activeTab === "baths"
      ? "Search bathrooms"
      : activeTab === "spaces"
        ? "Search shared spaces"
        : activeTab === "info"
          ? "Search house info"
          : activeTab === "manager"
            ? "Search manager tools"
            : activeTab === "house"
              ? "Search the house"
              : "Search rooms";

  const addPrimary =
    activeTab === "rooms"
      ? <PortalPrimaryIconAction label="Add room" onClick={addRoom} data-attr="property-house-details-add-room" />
      : activeTab === "baths"
        ? <PortalPrimaryIconAction label="Add bathroom" onClick={addBathroom} data-attr="property-house-details-add-bath" />
        : activeTab === "spaces"
          ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <PortalPrimaryIconAction label="Add shared space" data-attr="property-house-details-add-space" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {SHARED_SPACE_KIND_OPTIONS.map((opt) => (
                  <DropdownMenuItem key={opt.id} onClick={() => addSharedSpace(opt.id)}>
                    {opt.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )
          : null;

  const rulesSpec = HOUSE_INFO_SECTIONS.find((s) => s.id === "rules");

  return (
    <>
      <PortalRecordListSurface
        listControls={
          <PortalListControlStack
            variant="command"
            destinationRow={
              <LocalDestinationNav
                items={tabs.map((t) => ({
                  id: t.id,
                  label: t.label,
                  count: t.count,
                  dataAttr: `property-house-details-tab-${t.id}`,
                }))}
                activeId={activeTab}
                onChange={(id) => pickTab(id as HouseDetailsTabId)}
                ariaLabel="House details"
                appearance="command"
                tight
              />
            }
            activeDestinationId={activeTab}
            destinationAriaLabel="House details"
            search={{
              value: query,
              onChange: setQuery,
              placeholder: searchPlaceholder,
              ariaLabel: searchPlaceholder,
              dataAttr: "property-house-details-search",
            }}
            primary={addPrimary}
          />
        }
        isEmpty={
          searchNoMatches ||
          (activeTab === "rooms"
            ? rooms.length === 0
            : activeTab === "baths"
              ? baths.length === 0
              : activeTab === "spaces"
                ? spaces.length === 0
                : false)
        }
        emptyCard={
          searchNoMatches
            ? {
                title: "No matches",
                section: "house-details",
                tone: "muted",
                clear: { label: "Clear search", onClick: () => setQuery(""), dataAttr: "property-house-details-search-clear" },
              }
            : {
                title: activeTab === "rooms" ? "No rooms yet" : activeTab === "baths" ? "No bathrooms yet" : "Nothing here yet",
                section: "house-details",
              }
        }
      >
        {activeTab === "rooms"
          ? filteredRooms.map((room) => {
                const i = rooms.indexOf(room);
                const label = room.name.trim() || `Room ${i + 1}`;
                const bst = roomBathroomState(sub, room.id);
                return (
                  <PortalPropertyRecordRow
                    key={room.id}
                    title={label}
                    leading={<PortalRowIconTile icon={DoorOpen} />}
                    leadingShape="square"
                    facts={rowFacts([
                      { icon: Layers, text: room.floor?.trim() || "Floor not set", sr: "Floor" },
                      { icon: Bath, text: bathFactLabel(bst.mode, bst.location, bst.sharedWithRoomIds.length + 1), sr: "Bathroom" },
                      {
                        icon: (room.occupancyCapacity ?? 1) > 1 ? BedDouble : User,
                        text: wholePlace ? null : roomResidentsBedsText(room),
                        sr: "Residents",
                      },
                      {
                        icon: roomAvailabilityText(room) === "Occupied" ? CircleSlash : CircleCheck,
                        text: roomAvailabilityText(room),
                        sr: "Availability",
                      },
                    ])}
                    onOpen={() => openEditor({ kind: "room", roomId: room.id })}
                    dataAttr="property-house-details-room-row"
                    actions={roomRowMenu(
                      room.id,
                      label,
                      () => duplicateRoom(room.id),
                      rooms.length > 1 && isRoomSlotRemovable(room) ? () => removeRoom(room.id) : undefined,
                    )}
                  />
                );
              })
          : null}

        {activeTab === "baths"
          ? filteredBaths.map((bath) => {
              const i = baths.indexOf(bath);
              const label = bath.name.trim() || `Bathroom ${i + 1}`;
              return (
                <PortalPropertyRecordRow
                  key={bath.id}
                  title={label}
                  leading={<PortalRowIconTile icon={Bath} />}
                  leadingShape="square"
                  facts={rowFacts([
                    { icon: Layers, text: bath.location?.trim() || "Floor not set", sr: "Floor" },
                    { icon: Bath, text: bathAccessOf(sub, bath) === "shared" ? "Shared bath" : "Private bath", sr: "Access" },
                    {
                      icon: Users,
                      text: usersOfBath(sub, bath).length > 0 ? countWord(usersOfBath(sub, bath).length, "room") : "No rooms yet",
                      sr: "Rooms",
                    },
                  ])}
                  onOpen={() => openEditor({ kind: "bath", bathId: bath.id })}
                  dataAttr="property-house-details-bath-row"
                  actions={
                    <RowActionsMenu
                      label={label}
                      items={[
                        { id: "edit", label: "Edit", onSelect: () => openEditor({ kind: "bath", bathId: bath.id }) },
                        { id: "duplicate", label: "Duplicate", onSelect: () => duplicateBath(bath.id) },
                        baths.length > 1
                          ? { id: "delete", label: "Delete", danger: true, onSelect: () => removeBath(bath.id) }
                          : null,
                      ]}
                    />
                  }
                />
              );
            })
          : null}

        {activeTab === "spaces"
          ? filteredSpaces.map((space) => {
              const i = spaces.indexOf(space);
              const label = space.name.trim() || `Shared space ${i + 1}`;
              const kind = SHARED_SPACE_KIND_OPTIONS.find((o) => o.id === space.spaceKind)?.label ?? "";
              const access = sharedSpaceAccessTriggerLabel(space.roomAccessIds, rooms.map((r) => r.id));
              return (
                <PortalPropertyRecordRow
                  key={space.id}
                  title={label}
                  leading={<PortalRowIconTile icon={Home} />}
                  leadingShape="square"
                  facts={rowFacts([
                    { icon: Home, text: kind, sr: "Kind" },
                    { icon: Layers, text: space.location, sr: "Floor" },
                    { icon: Users, text: access, sr: "Access" },
                  ])}
                  onOpen={() => openEditor({ kind: "space", spaceId: space.id })}
                  dataAttr="property-house-details-space-row"
                  actions={
                    <RowActionsMenu
                      label={label}
                      items={[
                        { id: "edit", label: "Edit", onSelect: () => openEditor({ kind: "space", spaceId: space.id }) },
                        { id: "duplicate", label: "Duplicate", onSelect: () => duplicateSpace(space.id) },
                        { id: "delete", label: "Delete", danger: true, onSelect: () => removeSpace(space.id) },
                      ]}
                    />
                  }
                />
              );
            })
          : null}

        {activeTab === "info"
          ? (
            <>
              {filteredInfo.map((spec) => (
                <PortalPropertyRecordRow
                  key={spec.id}
                  title={spec.label}
                  leading={<PortalRowIconTile icon={FileText} />}
                  leadingShape="square"
                  facts={rowFacts([
                    { icon: Eye, text: "Residents only", sr: "Audience" },
                    { icon: FileText, text: houseInfoSectionSummaryLine(houseInfo, spec), sr: "Answers" },
                  ])}
                  onOpen={() => openEditor({ kind: "info", sectionId: spec.id })}
                  dataAttr={`property-house-details-info-${spec.id}`}
                  actions={
                    <RowActionsMenu
                      label={spec.label}
                      items={[
                        { id: "edit", label: "Edit", onSelect: () => openEditor({ kind: "info", sectionId: spec.id }) },
                        { id: "preview", label: "Preview", onSelect: () => setInfoPreview({ kind: "section", spec }) },
                      ]}
                    />
                  }
                />
              ))}
              {otherRowVisible ? (
                <PortalPropertyRecordRow
                  title="Anything else"
                  leading={<PortalRowIconTile icon={FileText} />}
                  leadingShape="square"
                  facts={rowFacts([
                    { icon: Eye, text: "Residents only", sr: "Audience" },
                    { icon: FileText, text: otherSummary, sr: "Answers" },
                  ])}
                  onOpen={() => openEditor({ kind: "infoOther" })}
                  dataAttr="property-house-details-info-other"
                  actions={
                    <RowActionsMenu
                      label="Anything else"
                      items={[
                        { id: "edit", label: "Edit", onSelect: () => openEditor({ kind: "infoOther" }) },
                        { id: "preview", label: "Preview", onSelect: () => setInfoPreview({ kind: "other" }) },
                      ]}
                    />
                  }
                />
              ) : null}
            </>
          )
          : null}

        {activeTab === "house" ? (
          <>
            {matches(`Property facts ${propertyFactsSummary(sub)}`) ? (
              <PortalPropertyRecordRow
                title="Property facts"
                leading={<PortalRowIconTile icon={Building2} />}
                leadingShape="square"
                onOpen={() => openEditor({ kind: "facts" })}
                dataAttr="property-house-details-facts-row"
                facts={rowFacts(
                  propertyFactsSummary(sub)
                    .split(" · ")
                    .map((text, index) => ({
                      icon: ([Home, Ruler, CalendarDays, MapPin] as const)[index] ?? Home,
                      text,
                    })),
                )}
                actions={
                  <RowActionsMenu
                    label="Property facts"
                    items={[{ id: "edit", label: "Edit", onSelect: () => openEditor({ kind: "facts" }) }]}
                  />
                }
              />
            ) : null}
            {matches(`Amenities ${propertyAmenitiesSummary(sub)}`) ? (
              <PortalPropertyRecordRow
                title="Amenities"
                leading={<PortalRowIconTile icon={Sparkles} />}
                leadingShape="square"
                onOpen={() => openEditor({ kind: "amenities" })}
                dataAttr="property-house-details-amenities-row"
                facts={[
                  <PortalRowFact key="amen" icon={Sparkles} srLabel="Amenities">
                    {propertyAmenitiesSummary(sub)}
                  </PortalRowFact>,
                ]}
                actions={
                  <RowActionsMenu
                    label="Amenities"
                    items={[{ id: "edit", label: "Edit", onSelect: () => openEditor({ kind: "amenities" }) }]}
                  />
                }
              />
            ) : null}
            {matches("Rules") && rulesSpec ? (
            <PortalPropertyRecordRow
              title="Rules"
              leading={<PortalRowIconTile icon={ShieldCheck} />}
              leadingShape="square"
              facts={rowFacts([{ icon: ShieldCheck, text: houseInfoSectionSummaryLine(houseInfo, rulesSpec), sr: "Rules" }])}
              onOpen={() => openEditor({ kind: "info", sectionId: "rules" })}
              dataAttr="property-house-details-house-rules-row"
              actions={
                <RowActionsMenu
                  label="Rules"
                  items={[
                    { id: "edit", label: "Edit", onSelect: () => openEditor({ kind: "info", sectionId: "rules" }) },
                    { id: "preview", label: "Preview", onSelect: () => setInfoPreview({ kind: "section", spec: rulesSpec }) },
                  ]}
                />
              }
            />
            ) : null}
          </>
        ) : null}

        {activeTab === "manager" ? (
          <>
            <PortalPropertyRecordRow
              title="Manager notes"
              leading={<PortalRowIconTile icon={Lock} />}
              leadingShape="square"
              onOpen={() => openEditor({ kind: "managerNotes" })}
              dataAttr="property-house-details-manager-notes-row"
              facts={rowFacts([
                { icon: Lock, text: "Manager only", sr: "Audience" },
                { icon: FileText, text: managerNotes.trim() ? "Has notes" : "Nothing added yet", sr: "Notes" },
              ])}
              actions={
                <RowActionsMenu
                  label="Manager notes"
                  items={[{ id: "edit", label: "Edit", onSelect: () => openEditor({ kind: "managerNotes" }) }]}
                />
              }
            />
            {earlierNotes ? (
              <PortalPropertyRecordRow
                title="Earlier notes"
                leading={<PortalRowIconTile icon={FileText} />}
                leadingShape="square"
                onOpen={earlierNotes.onOpen}
                dataAttr="property-house-details-earlier-notes-row"
                facts={rowFacts([{ icon: Lock, text: "Manager only", sr: "Audience" }])}
                actions={
                  <RowActionsMenu label="Earlier notes" items={[{ id: "edit", label: "Edit", onSelect: earlierNotes.onOpen }]} />
                }
              />
            ) : null}
            {propertyId ? <HousePrintablesCard propertyId={propertyId} rooms={rooms} showToast={showToast} /> : null}
          </>
        ) : null}
      </PortalRecordListSurface>

      <PropertySectionPreviewModal
        open={infoPreview !== null}
        title={
          infoPreview?.kind === "other"
            ? "Anything else"
            : infoPreview?.spec.label ?? ""
        }
        onClose={() => setInfoPreview(null)}
        onEdit={() => {
          if (!infoPreview) return;
          if (infoPreview.kind === "other") openEditor({ kind: "infoOther" });
          else openEditor({ kind: "info", sectionId: infoPreview.spec.id });
          setInfoPreview(null);
        }}
      >
        {infoPreview?.kind === "other" ? (
          houseInfo.other.trim() ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{houseInfo.other}</p>
          ) : (
            <p className="text-sm text-muted">Nothing added yet</p>
          )
        ) : infoPreview?.kind === "section" ? (
          (() => {
            const section = houseInfoRenderSections(houseInfo).find((s) => s.id === infoPreview.spec.id);
            if (!section?.rows.length) return <p className="text-sm text-muted">Nothing added yet</p>;
            return (
              <dl className="space-y-2">
                {section.rows.map((row) => (
                  <div key={row.label} className="flex flex-wrap justify-between gap-2 border-b border-border/50 py-2 last:border-0">
                    <dt className="text-xs text-muted">{row.label}</dt>
                    <dd className="max-w-[70%] text-right text-sm font-medium">{row.value}</dd>
                  </div>
                ))}
              </dl>
            );
          })()
        ) : null}
      </PropertySectionPreviewModal>

      <PropertyHouseDetailsEditorModal
        open={editorOpen}
        target={target}
        sub={sub}
        propertyId={propertyId}
        managerUserId={managerUserId}
        onGoToBathrooms={() => {
          pickTab("baths");
          setEditorOpen(false);
        }}
        onOpenLinkedRoom={(roomId) => {
          openEditor({ kind: "room", roomId });
        }}
        houseInfo={houseInfo}
        managerNotes={managerNotes}
        onClose={() => setEditorOpen(false)}
        onSave={saveEditor}
        busy={saving}
      />
    </>
  );
}
