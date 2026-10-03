"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ListingBathroomEditorBody,
  ListingRoomEditorBody,
} from "@/components/portal/listing-wizard-v2/listing-editor";
import { ListingSharedSpaceEditorBody } from "@/components/portal/listing-wizard-v2/listing-editor";
import { HouseInfoEditor } from "@/components/portal/house-info-sections";
import {
  bathroomDescriptionIsBlank,
  bathroomDescriptionMatches,
  bathroomSetupIsBlank,
  bathroomSetupMatches,
  copyBathroomSetupFrom,
  copySharedSpaceSetupFrom,
  sharedSpaceSetupIsBlank,
  sharedSpaceSetupMatches,
} from "@/lib/listing-record-defaults";
import {
  copyRoomDescriptionFrom,
  roomDescriptionIsBlank,
  roomDescriptionMatches,
} from "@/lib/listing-house-defaults";
import type {
  ManagerBathroomSubmission,
  ManagerListingSubmissionV1,
  ManagerRoomSubmission,
  ManagerSharedSpaceSubmission,
} from "@/lib/manager-listing-submission";
import { isEntireHomeListing } from "@/lib/manager-listing-submission";
import { setHouseInfoValue, type HouseInfoSectionId, type HouseInfoV1 } from "@/lib/house-info";
import { copyRoomBathroomLinkFrom } from "@/lib/listing-room-editor/bathroom-link";

export type HouseDetailsEditorTarget =
  | { kind: "room"; roomId: string }
  | { kind: "bath"; bathId: string }
  | { kind: "space"; spaceId: string }
  | { kind: "info"; sectionId: HouseInfoSectionId }
  | { kind: "managerNotes" };

export function PropertyHouseDetailsEditorModal({
  open,
  target,
  sub,
  propertyId,
  managerUserId,
  houseInfo,
  managerNotes,
  onClose,
  onSave,
  onGoToBathrooms,
  onOpenLinkedRoom,
  busy,
}: {
  open: boolean;
  target: HouseDetailsEditorTarget | null;
  sub: ManagerListingSubmissionV1;
  propertyId: string | null;
  managerUserId: string | null;
  houseInfo: HouseInfoV1;
  managerNotes: string;
  onClose: () => void;
  onGoToBathrooms?: () => void;
  onOpenLinkedRoom?: (roomId: string) => void;
  onSave: (next: {
    sub: ManagerListingSubmissionV1;
    houseInfo: HouseInfoV1;
    managerNotes: string;
  }) => void;
  busy?: boolean;
}) {
  const [draftSub, setDraftSub] = useState(sub);
  const [draftInfo, setDraftInfo] = useState(houseInfo);
  const [draftNotes, setDraftNotes] = useState(managerNotes);

  useEffect(() => {
    if (!open) return;
    setDraftSub(sub);
    setDraftInfo(houseInfo);
    setDraftNotes(managerNotes);
  }, [open, sub, houseInfo, managerNotes]);

  const wholePlace = isEntireHomeListing(draftSub);
  const rooms = draftSub.rooms ?? [];
  const baths = draftSub.bathrooms ?? [];
  const spaces = draftSub.sharedSpaces ?? [];

  const room = target?.kind === "room" ? rooms.find((r) => r.id === target.roomId) : null;
  const bath = target?.kind === "bath" ? baths.find((b) => b.id === target.bathId) : null;
  const space = target?.kind === "space" ? spaces.find((s) => s.id === target.spaceId) : null;

  const title = useMemo(() => {
    if (!target) return "";
    if (target.kind === "room") return room?.name.trim() || "Room";
    if (target.kind === "bath") return bath?.name.trim() || "Bathroom";
    if (target.kind === "space") return space?.name.trim() || "Shared space";
    if (target.kind === "managerNotes") return "Manager notes";
    return "House details";
  }, [target, room, bath, space]);

  if (!target) return null;

  const patchRoom = (roomId: string, patch: Partial<ManagerRoomSubmission>) => {
    setDraftSub((prev) => ({
      ...prev,
      rooms: (prev.rooms ?? []).map((r) => (r.id === roomId ? { ...r, ...patch } : r)),
    }));
  };

  const patchBath = (bathId: string, patch: Partial<ManagerBathroomSubmission>) => {
    setDraftSub((prev) => ({
      ...prev,
      bathrooms: (prev.bathrooms ?? []).map((b) => (b.id === bathId ? { ...b, ...patch } : b)),
    }));
  };

  const patchSpace = (spaceId: string, patch: Partial<ManagerSharedSpaceSubmission>) => {
    setDraftSub((prev) => ({
      ...prev,
      sharedSpaces: (prev.sharedSpaces ?? []).map((s) => (s.id === spaceId ? { ...s, ...patch } : s)),
    }));
  };

  const roomLabel = (r: ManagerRoomSubmission, i: number) => r.name.trim() || `Room ${i + 1}`;
  const sameAsRoomOptions = (r: ManagerRoomSubmission) => [
    { value: "", label: "Set for this room" },
    ...rooms.filter((x) => x.id !== r.id).map((x) => ({ value: x.id, label: `Same as ${roomLabel(x, rooms.indexOf(x))}` })),
  ];
  const sameAsRoomValue = (r: ManagerRoomSubmission) =>
    roomDescriptionIsBlank(r) ? "" : rooms.find((x) => x.id !== r.id && roomDescriptionMatches(x, r))?.id ?? "";

  const bathLabel = (b: ManagerBathroomSubmission, i: number) => b.name.trim() || `Bathroom ${i + 1}`;
  const sameAsBathOptions = (b: ManagerBathroomSubmission) => [
    { value: "", label: "Set for this bathroom" },
    ...baths.filter((x) => x.id !== b.id).map((x) => ({ value: x.id, label: `Same as ${bathLabel(x, baths.indexOf(x))}` })),
  ];
  const sameAsBathValue = (b: ManagerBathroomSubmission) =>
    bathroomSetupIsBlank(b) ? "" : baths.find((x) => x.id !== b.id && bathroomSetupMatches(x, b))?.id ?? "";

  const spaceLabel = (s: ManagerSharedSpaceSubmission, i: number) => s.name.trim() || `Shared space ${i + 1}`;
  const sameAsSpaceOptions = (s: ManagerSharedSpaceSubmission) => [
    { value: "", label: "Set for this space" },
    ...spaces.filter((x) => x.id !== s.id).map((x) => ({ value: x.id, label: `Same as ${spaceLabel(x, spaces.indexOf(x))}` })),
  ];
  const sameAsSpaceValue = (s: ManagerSharedSpaceSubmission) =>
    sharedSpaceSetupIsBlank(s) ? "" : spaces.find((x) => x.id !== s.id && sharedSpaceSetupMatches(x, s))?.id ?? "";

  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      panelClassName="max-w-3xl"
      footer={
        <ModalFooter className="w-full gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            type="button"
            variant="primary"
            className="ml-auto rounded-full"
            disabled={busy}
            data-attr="property-house-details-save"
            onClick={() => onSave({ sub: draftSub, houseInfo: draftInfo, managerNotes: draftNotes })}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </ModalFooter>
      }
    >
      {target.kind === "room" && room ? (
        <div className="rounded-2xl border border-border bg-card" data-attr="property-house-details-room-editor">
          <div className="border-b border-border px-3.5 py-2">
            <Input
              aria-label="Room name"
              value={room.name}
              onChange={(e) => patchRoom(room.id, { name: e.target.value })}
            />
          </div>
          <ListingRoomEditorBody
            sub={draftSub}
            room={room}
            propertyId={propertyId}
            managerUserId={managerUserId}
            who={roomLabel(room, rooms.indexOf(room))}
            wholePlace={wholePlace}
            onPatchBathrooms={(bathrooms) => setDraftSub((prev) => ({ ...prev, bathrooms }))}
            onGoToBathrooms={() => onGoToBathrooms?.()}
            onRoom={(p) => patchRoom(room.id, p)}
            storiesId={draftSub.listingStoriesId}
            sameAsOptions={sameAsRoomOptions(room)}
            sameAsValue={sameAsRoomValue(room)}
            showSharedRoomConfig
            onSameAs={(otherId) => {
              const source = rooms.find((r) => r.id === otherId);
              if (!source) return;
              patchRoom(room.id, copyRoomDescriptionFrom(source, room));
              setDraftSub((prev) => copyRoomBathroomLinkFrom(prev, room.id, otherId));
            }}
          />
        </div>
      ) : null}

      {target.kind === "bath" && bath ? (
        <div className="rounded-2xl border border-border bg-card" data-attr="property-house-details-bath-editor">
          <div className="border-b border-border px-3.5 py-2">
            <Input
              aria-label="Bathroom name"
              value={bath.name}
              onChange={(e) => patchBath(bath.id, { name: e.target.value })}
            />
          </div>
          <ListingBathroomEditorBody
            sub={draftSub}
            bath={bath}
            who={bathLabel(bath, baths.indexOf(bath))}
            rooms={rooms}
            wholePlace={wholePlace}
            storiesId={draftSub.listingStoriesId}
            sameAsOptions={sameAsBathOptions(bath)}
            sameAsValue={sameAsBathValue(bath)}
            onSameAs={(otherId) => {
              const source = baths.find((b) => b.id === otherId);
              if (!source) return;
              patchBath(bath.id, copyBathroomSetupFrom(source, bath));
            }}
            onChange={(p) => patchBath(bath.id, p)}
            onPatchSubmission={(next) => setDraftSub(next)}
            onOpenRoom={onOpenLinkedRoom}
          />
        </div>
      ) : null}

      {target.kind === "space" && space ? (
        <div className="rounded-2xl border border-border bg-card px-1 py-1" data-attr="property-house-details-space-editor">
          <ListingSharedSpaceEditorBody
            space={space}
            who={spaceLabel(space, spaces.indexOf(space))}
            rooms={rooms}
            wholePlace={wholePlace}
            storiesId={draftSub.listingStoriesId}
            onChange={(p) => patchSpace(space.id, p)}
            sameAsOptions={sameAsSpaceOptions(space)}
            sameAsValue={sameAsSpaceValue(space)}
            onSameAs={(otherId) => {
              const source = spaces.find((s) => s.id === otherId);
              if (!source) return;
              patchSpace(space.id, copySharedSpaceSetupFrom(source, space));
            }}
          />
        </div>
      ) : null}

      {target.kind === "info" ? (
        <HouseInfoEditor
          info={draftInfo}
          sectionIds={[target.sectionId]}
          layout="rows"
          onChange={(sectionId, key, value) => {
            setDraftInfo((prev) => setHouseInfoValue(prev, sectionId, key, value));
          }}
          onOtherChange={(value) => setDraftInfo((prev) => ({ ...prev, other: value }))}
        />
      ) : null}

      {target.kind === "managerNotes" ? (
        <textarea
          className="min-h-[120px] w-full rounded-xl border border-border bg-card p-3 text-sm"
          aria-label="Manager notes"
          value={draftNotes}
          onChange={(e) => setDraftNotes(e.target.value)}
        />
      ) : null}
    </Modal>
  );
}
