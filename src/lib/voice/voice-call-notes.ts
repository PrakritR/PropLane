/** Client-safe helpers for voice call notes that land in Communication chat. */

export const VOICE_CALL_NOTE_SID_PREFIX = "voice:";

export type VoiceCallNoteKind = "started" | "user" | "agent" | "ended";

export function isVoiceCallNoteSid(messageSid: string | null | undefined): boolean {
  return String(messageSid ?? "").startsWith(VOICE_CALL_NOTE_SID_PREFIX);
}

export function voiceCallNoteSid(parts: {
  callSid: string;
  kind: VoiceCallNoteKind;
  digest?: string;
}): string {
  const callSid = parts.callSid.trim();
  const digest = String(parts.digest ?? "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 32);
  return digest
    ? `${VOICE_CALL_NOTE_SID_PREFIX}${callSid}:${parts.kind}:${digest}`
    : `${VOICE_CALL_NOTE_SID_PREFIX}${callSid}:${parts.kind}`;
}

/** List-row prefix so a voice turn is obviously a call, not a text. */
export function voiceCallListPreviewPrefix(): string {
  return "Call: ";
}
