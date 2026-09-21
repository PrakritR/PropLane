/**
 * Pure text/URL builders for the manager move-in Copy and Share icon actions
 * (`pro-property-room-move-in-panel.tsx`). No React, no clipboard access — the
 * component owns `navigator.clipboard.writeText`.
 */

/** The resident-facing move-in link for one room, scoped by `?room=`. */
export function roomMoveInShareUrl(origin: string, roomId: string): string {
  return `${origin}/resident/move-in/info?room=${encodeURIComponent(roomId)}`;
}

function mediaLine(photoCount: number, hasVideo: boolean): string | null {
  const parts: string[] = [];
  if (photoCount > 0) parts.push(`${photoCount} photo${photoCount === 1 ? "" : "s"}`);
  if (hasVideo) parts.push("1 video");
  return parts.length > 0 ? parts.join(" · ") : null;
}

export type RoomMoveInClipboardResident = {
  slot: number;
  instructions: string;
  photoCount: number;
  hasVideo: boolean;
};

export type RoomMoveInClipboardInput = {
  roomLabel: string;
  instructions: string;
  photoCount: number;
  hasVideo: boolean;
  residents?: RoomMoveInClipboardResident[];
};

/**
 * The plain-text summary copied to the clipboard for one room's move-in
 * details. Never includes a data URL — only counts. A resident with no
 * content of their own (no text, no photos, no video) is omitted entirely.
 */
export function roomMoveInClipboardText(input: RoomMoveInClipboardInput): string {
  const lines: string[] = [`${input.roomLabel} — move-in`];

  const instructions = input.instructions.trim();
  if (instructions) lines.push(instructions);

  const roomMedia = mediaLine(input.photoCount, input.hasVideo);
  if (roomMedia) lines.push(roomMedia);

  for (const resident of input.residents ?? []) {
    const residentInstructions = resident.instructions.trim();
    const residentMedia = mediaLine(resident.photoCount, resident.hasVideo);
    if (!residentInstructions && !residentMedia) continue;

    lines.push("", `Resident ${resident.slot}`);
    if (residentInstructions) lines.push(residentInstructions);
    if (residentMedia) lines.push(residentMedia);
  }

  return lines.join("\n");
}
