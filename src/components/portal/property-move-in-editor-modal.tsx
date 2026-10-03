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
import type { ManagerRoomResidentMoveIn, ManagerRoomSubmission } from "@/lib/manager-listing-submission";

export type MoveInEditorTarget =
  | { kind: "house" }
  | { kind: "room"; roomId: string }
  | { kind: "roomResident"; roomId: string; slotIndex: number };

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
  onSaveRoomResident,
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
  onSaveRoomResident?: (roomId: string, slotIndex: number, patch: ManagerRoomResidentMoveIn) => void;
  busy?: boolean;
  canEdit: boolean;
  onError: (message: string) => void;
}) {
  const [draftInfo, setDraftInfo] = useState(houseInfo);
  const [instr, setInstr] = useState(houseInstructions);
  const [photos, setPhotos] = useState(housePhotos);
  const [video, setVideo] = useState(houseVideo);
  const [roomDraft, setRoomDraft] = useState<ManagerRoomSubmission | null>(room);

  // ✕ and Esc close and keep the draft (ui-page-structure.md § Pop-ups), so the
  // working copy re-seeds only when the target or the saved values change —
  // not every time the popup reopens.
  useEffect(() => {
    setDraftInfo(houseInfo);
    setInstr(houseInstructions);
    setPhotos(housePhotos);
    setVideo(houseVideo);
    setRoomDraft(room);
  }, [houseInfo, houseInstructions, housePhotos, houseVideo, room, target]);

  if (!target) return null;

  const title =
    target.kind === "house"
      ? "The whole house"
      : target.kind === "roomResident"
        ? `${room?.name.trim() || "Room"} · Resident ${target.slotIndex + 1}`
        : room?.name.trim() || "Room";

  return (
    <Modal
      open={open}
      title={`Edit move-in · ${title}`}
      onClose={onClose}
      panelClassName="max-w-3xl"
      footer={
        <ModalFooter className="w-full gap-2">
          <Button
            type="button"
            variant="primary"
            className="ml-auto rounded-full"
            disabled={busy || !canEdit}
            data-attr="property-move-in-save"
            onClick={() => {
              if (target.kind === "house") {
                onSaveHouse({ houseInfo: draftInfo, instructions: instr, photos, video });
              } else if (target.kind === "roomResident" && roomDraft && onSaveRoomResident) {
                const entry = roomDraft.moveInResidentDetails?.[target.slotIndex];
                onSaveRoomResident(roomDraft.id, target.slotIndex, {
                  moveInInstructions: entry?.moveInInstructions ?? "",
                  moveInPhotoDataUrls: [...(entry?.moveInPhotoDataUrls ?? [])],
                  moveInVideoDataUrl: entry?.moveInVideoDataUrl ?? null,
                });
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

      {target.kind === "roomResident" && roomDraft ? (
        <MoveInCardFields
          instructions={roomDraft.moveInResidentDetails?.[target.slotIndex]?.moveInInstructions ?? ""}
          photoDataUrls={roomDraft.moveInResidentDetails?.[target.slotIndex]?.moveInPhotoDataUrls ?? []}
          videoDataUrl={roomDraft.moveInResidentDetails?.[target.slotIndex]?.moveInVideoDataUrl ?? null}
          disabled={!canEdit}
          onInstructionsChange={(value) =>
            setRoomDraft((r) => {
              if (!r) return r;
              const rows = [...(r.moveInResidentDetails ?? [])];
              while (rows.length <= target.slotIndex) {
                rows.push({ moveInInstructions: "", moveInPhotoDataUrls: [], moveInVideoDataUrl: null });
              }
              rows[target.slotIndex] = { ...rows[target.slotIndex]!, moveInInstructions: value };
              return { ...r, moveInResidentDetails: rows };
            })
          }
          onPhotosChange={(urls) =>
            setRoomDraft((r) => {
              if (!r) return r;
              const rows = [...(r.moveInResidentDetails ?? [])];
              while (rows.length <= target.slotIndex) {
                rows.push({ moveInInstructions: "", moveInPhotoDataUrls: [], moveInVideoDataUrl: null });
              }
              rows[target.slotIndex] = { ...rows[target.slotIndex]!, moveInPhotoDataUrls: urls };
              return { ...r, moveInResidentDetails: rows };
            })
          }
          onVideoChange={(url) =>
            setRoomDraft((r) => {
              if (!r) return r;
              const rows = [...(r.moveInResidentDetails ?? [])];
              while (rows.length <= target.slotIndex) {
                rows.push({ moveInInstructions: "", moveInPhotoDataUrls: [], moveInVideoDataUrl: null });
              }
              rows[target.slotIndex] = { ...rows[target.slotIndex]!, moveInVideoDataUrl: url };
              return { ...r, moveInResidentDetails: rows };
            })
          }
          onError={onError}
        />
      ) : null}
    </Modal>
  );
}
