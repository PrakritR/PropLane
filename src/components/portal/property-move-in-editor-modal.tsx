"use client";

import { useEffect, useState } from "react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { HouseInfoEditor } from "@/components/portal/house-info-sections";
import { MoveInCardFields } from "@/components/portal/pro-property-room-move-in-panel";
import {
  HOUSE_INFO_MOVE_IN_SECTION_IDS,
  setHouseInfoValue,
  type HouseInfoV1,
} from "@/lib/house-info";
import type { ManagerRoomSubmission } from "@/lib/manager-listing-submission";

export type MoveInEditorTarget =
  | { kind: "house" }
  | { kind: "room"; roomId: string };

export function PropertyMoveInEditorModal({
  open,
  target,
  houseInfo,
  houseInstructions,
  housePhotos,
  houseVideo,
  room,
  onClose,
  onSaveHouse,
  onSaveRoom,
  busy,
  canEdit,
  onError,
}: {
  open: boolean;
  target: MoveInEditorTarget | null;
  houseInfo: HouseInfoV1;
  houseInstructions: string;
  housePhotos: string[];
  houseVideo: string | null;
  room: ManagerRoomSubmission | null;
  onClose: () => void;
  onSaveHouse: (payload: {
    houseInfo: HouseInfoV1;
    instructions: string;
    photos: string[];
    video: string | null;
  }) => void;
  onSaveRoom: (roomId: string, patch: Partial<ManagerRoomSubmission>) => void;
  busy?: boolean;
  canEdit: boolean;
  onError: (message: string) => void;
}) {
  const [draftInfo, setDraftInfo] = useState(houseInfo);
  const [instr, setInstr] = useState(houseInstructions);
  const [photos, setPhotos] = useState(housePhotos);
  const [video, setVideo] = useState(houseVideo);
  const [roomDraft, setRoomDraft] = useState<ManagerRoomSubmission | null>(room);

  useEffect(() => {
    if (!open) return;
    setDraftInfo(houseInfo);
    setInstr(houseInstructions);
    setPhotos(housePhotos);
    setVideo(houseVideo);
    setRoomDraft(room);
  }, [open, houseInfo, houseInstructions, housePhotos, houseVideo, room]);

  if (!target) return null;

  const title = target.kind === "house" ? "The whole house" : room?.name.trim() || "Room";

  return (
    <Modal
      open={open}
      title={`Edit move-in · ${title}`}
      onClose={onClose}
      panelClassName="max-w-3xl"
      footer={
        <ModalFooter className="w-full gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            type="button"
            variant="primary"
            className="ml-auto rounded-full"
            disabled={busy || !canEdit}
            data-attr="property-move-in-save"
            onClick={() => {
              if (target.kind === "house") {
                onSaveHouse({ houseInfo: draftInfo, instructions: instr, photos, video });
              } else if (roomDraft) {
                onSaveRoom(roomDraft.id, {
                  moveInInstructions: roomDraft.moveInInstructions ?? "",
                  moveInPhotoDataUrls: [...(roomDraft.moveInPhotoDataUrls ?? [])],
                  moveInVideoDataUrl: roomDraft.moveInVideoDataUrl ?? null,
                });
              }
            }}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </ModalFooter>
      }
    >
      {target.kind === "house" ? (
        <div className="space-y-4" data-attr="property-move-in-house-editor">
          <HouseInfoEditor
            info={draftInfo}
            sectionIds={[...HOUSE_INFO_MOVE_IN_SECTION_IDS]}
            onChange={(sectionId, key, value) => {
              setDraftInfo((prev) => setHouseInfoValue(prev, sectionId, key, value));
            }}
            onOtherChange={() => {}}
          />
          <MoveInCardFields
            instructions={instr}
            photoDataUrls={photos}
            videoDataUrl={video}
            disabled={!canEdit}
            onInstructionsChange={setInstr}
            onPhotosChange={setPhotos}
            onVideoChange={setVideo}
            onError={onError}
          />
        </div>
      ) : null}

      {target.kind === "room" && roomDraft ? (
        <MoveInCardFields
          instructions={roomDraft.moveInInstructions ?? ""}
          photoDataUrls={roomDraft.moveInPhotoDataUrls ?? []}
          videoDataUrl={roomDraft.moveInVideoDataUrl ?? null}
          disabled={!canEdit}
          onInstructionsChange={(value) => setRoomDraft((r) => (r ? { ...r, moveInInstructions: value } : r))}
          onPhotosChange={(urls) => setRoomDraft((r) => (r ? { ...r, moveInPhotoDataUrls: urls } : r))}
          onVideoChange={(url) => setRoomDraft((r) => (r ? { ...r, moveInVideoDataUrl: url } : r))}
          onError={onError}
        />
      ) : null}
    </Modal>
  );
}
