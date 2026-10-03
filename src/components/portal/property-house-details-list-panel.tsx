"use client";

import { useCallback, useMemo, useState } from "react";
import { BedDouble, Building2, Home, Lock, Sparkles } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPropertyRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { RowActionsMenu } from "@/components/portal/row-actions-menu";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import {
  PropertyHouseDetailsEditorModal,
  type HouseDetailsEditorTarget,
} from "@/components/portal/property-house-details-editor-modal";
import { HousePrintablesCard } from "@/components/portal/house-printables-card";
import {
  HOUSE_INFO_MOVE_IN_SECTION_IDS,
  HOUSE_INFO_SECTIONS,
  houseInfoSectionCount,
  houseInfoSectionIsEmpty,
  type HouseInfoSectionId,
  type HouseInfoV1,
} from "@/lib/house-info";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { bathFactLabel, roomBathroomState } from "@/lib/listing-room-editor/bathroom-link";
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

export function PropertyHouseDetailsListPanel({
  propertyId,
  sub,
  houseInfo,
  managerNotes,
  managerUserId,
  onPersist,
  showToast,
}: {
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

  const infoSections = useMemo(
    () =>
      HOUSE_INFO_SECTIONS.filter(
        (s) => !HOUSE_INFO_MOVE_IN_SECTION_IDS.includes(s.id as HouseInfoSectionId),
      ),
    [],
  );

  const tabs = useMemo(() => {
    const infoCount = infoSections.filter((s) => !houseInfoSectionIsEmpty(houseInfo, s)).length;
    return [
      { id: "rooms" as const, label: "Rooms", count: rooms.length },
      { id: "baths" as const, label: "Bathrooms", count: baths.length },
      { id: "spaces" as const, label: "Shared spaces", count: spaces.length, hide: spaces.length === 0 },
      { id: "house" as const, label: "The house", count: 3 },
      { id: "info" as const, label: "Residents read this", count: infoCount },
      { id: "manager" as const, label: "Manager tools", count: 3 },
    ].filter((t) => !t.hide);
  }, [rooms.length, baths.length, spaces.length, infoSections, houseInfo]);

  const activeTab = tabs.find((t) => t.id === tab)?.id ?? tabs[0]?.id ?? "rooms";

  const matches = useCallback(
    (text: string) => !query.trim() || text.toLowerCase().includes(query.trim().toLowerCase()),
    [query],
  );

  const roomRowMenu = (roomId: string, label: string, onDuplicate: () => void, onRemove?: () => void) => (
    <RowActionsMenu
      label={label}
      items={[
        { id: "duplicate", label: "Duplicate", onSelect: onDuplicate },
        { id: "edit", label: "Edit", onSelect: () => openEditor({ kind: "room", roomId }) },
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
      infoSections.filter((spec) => {
        const count = houseInfoSectionCount(houseInfo, spec);
        return matches(`${spec.label} ${count.filled} ${count.total}`);
      }),
    [infoSections, houseInfo, matches],
  );

  const tabHasRows =
    activeTab === "rooms"
      ? rooms.length > 0
      : activeTab === "baths"
        ? baths.length > 0
        : activeTab === "spaces"
          ? spaces.length > 0
          : activeTab === "info"
            ? infoSections.length > 0
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
            ? filteredInfo.length
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
                itemLayout="equal"
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
                const residents = room.occupancyCapacity ?? 1;
                return (
                  <PortalPropertyRecordRow
                    key={room.id}
                    title={label}
                    summary={[
                      !wholePlace ? `${residents} residents` : null,
                      room.floor || "Floor not set",
                      bathFactLabel(bst.mode, bst.location, bst.sharedWithRoomIds.length + 1),
                      roomFurnishingLabel(roomFurnitureItems(room)),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    onOpen={() => openEditor({ kind: "room", roomId: room.id })}
                    dataAttr="property-house-details-room-row"
                    facts={[
                      !wholePlace ? (
                        <PortalRowFact key="res" icon={BedDouble} srLabel="Residents">{`${residents}`}</PortalRowFact>
                      ) : null,
                      <PortalRowFact key="furn" icon={Home} srLabel="Furnished">
                        {roomFurnishingLabel(roomFurnitureItems(room))}
                      </PortalRowFact>,
                    ].filter(Boolean)}
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
                  summary={bath.location || "Floor not set"}
                  onOpen={() => openEditor({ kind: "bath", bathId: bath.id })}
                  dataAttr="property-house-details-bath-row"
                  actions={
                    <RowActionsMenu
                      label={label}
                      items={[
                        { id: "duplicate", label: "Duplicate", onSelect: () => duplicateBath(bath.id) },
                        { id: "edit", label: "Edit", onSelect: () => openEditor({ kind: "bath", bathId: bath.id }) },
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
                  summary={[kind, space.location, access].filter(Boolean).join(" · ")}
                  onOpen={() => openEditor({ kind: "space", spaceId: space.id })}
                  dataAttr="property-house-details-space-row"
                  actions={
                    <RowActionsMenu
                      label={label}
                      items={[
                        { id: "duplicate", label: "Duplicate", onSelect: () => duplicateSpace(space.id) },
                        { id: "edit", label: "Edit", onSelect: () => openEditor({ kind: "space", spaceId: space.id }) },
                        { id: "delete", label: "Delete", danger: true, onSelect: () => removeSpace(space.id) },
                      ]}
                    />
                  }
                />
              );
            })
          : null}

        {activeTab === "info"
          ? filteredInfo.map((spec) => {
              const count = houseInfoSectionCount(houseInfo, spec);
              return (
                <PortalPropertyRecordRow
                  key={spec.id}
                  title={spec.label}
                  summary={count.filled ? `${count.filled} of ${count.total} filled` : "Nothing added yet"}
                  onOpen={() => openEditor({ kind: "info", sectionId: spec.id })}
                  dataAttr={`property-house-details-info-${spec.id}`}
                  actions={
                    <RowActionsMenu
                      label={spec.label}
                      items={[{ id: "edit", label: "Edit", onSelect: () => openEditor({ kind: "info", sectionId: spec.id }) }]}
                    />
                  }
                />
              );
            })
          : null}

        {activeTab === "house" ? (
          <>
            {matches(`Property facts ${propertyFactsSummary(sub)}`) ? (
              <PortalPropertyRecordRow
                title="Property facts"
                summary={propertyFactsSummary(sub)}
                onOpen={() => openEditor({ kind: "facts" })}
                dataAttr="property-house-details-facts-row"
                facts={[
                  <PortalRowFact key="kind" icon={Building2} srLabel="Type">
                    {propertyFactsSummary(sub).split(" · ")[0]}
                  </PortalRowFact>,
                ]}
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
                summary={propertyAmenitiesSummary(sub)}
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
            {matches("Rules") ? (
            <PortalPropertyRecordRow
              title="Rules"
              summary={
                rulesSpec && !houseInfoSectionIsEmpty(houseInfo, rulesSpec)
                  ? `${houseInfoSectionCount(houseInfo, rulesSpec).filled} of ${houseInfoSectionCount(houseInfo, rulesSpec).total} filled`
                  : "Nothing added yet"
              }
              onOpen={() => openEditor({ kind: "info", sectionId: "rules" })}
              dataAttr="property-house-details-house-rules-row"
              actions={
                <RowActionsMenu
                  label="Rules"
                  items={[{ id: "edit", label: "Edit", onSelect: () => openEditor({ kind: "info", sectionId: "rules" }) }]}
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
              summary={managerNotes.trim() ? "Has notes" : "Nothing added yet"}
              onOpen={() => openEditor({ kind: "managerNotes" })}
              dataAttr="property-house-details-manager-notes-row"
              facts={[<PortalRowFact key="lock" icon={Lock} srLabel="Audience">Manager only</PortalRowFact>]}
              actions={
                <RowActionsMenu
                  label="Manager notes"
                  items={[{ id: "edit", label: "Edit", onSelect: () => openEditor({ kind: "managerNotes" }) }]}
                />
              }
            />
            {propertyId ? (
              <div className="px-1 pt-2">
                <HousePrintablesCard propertyId={propertyId} rooms={rooms} showToast={showToast} />
              </div>
            ) : null}
          </>
        ) : null}
      </PortalRecordListSurface>

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
