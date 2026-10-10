/** What a manager types about an imported channel stay (the feed itself never carries the guest's name). */
export const CHANNEL_STAY_GUEST_NAME_MAX = 120;
export const CHANNEL_STAY_NOTES_MAX = 1000;

export type ChannelStayDetails = { guestName: string; notes: string };

/** Strip control characters, collapse whitespace, trim, cap. */
export function normalizeStayGuestName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, CHANNEL_STAY_GUEST_NAME_MAX);
}

export function normalizeStayNotes(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ").trim().slice(0, CHANNEL_STAY_NOTES_MAX);
}
