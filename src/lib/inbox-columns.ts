/**
 * How many columns Communication draws, picked from the width of the
 * Communication surface itself (never the viewport, so the docked assistant, the
 * sidebar and full screen all count with no special cases).
 *
 *   3: list 320 · thread (440+) · details 280   at 1040px and up
 *   2: list 320 · thread (440+)                  760-1039px
 *   1: the thread alone (list alone when none is open) under 760px
 */
export type InboxColumns = 3 | 2 | 1;

export const INBOX_LIST_COLUMN_PX = 320;
export const INBOX_THREAD_MIN_PX = 440;
export const INBOX_DETAILS_COLUMN_PX = 280;
export const INBOX_THREE_COLUMN_MIN_PX = INBOX_LIST_COLUMN_PX + INBOX_THREAD_MIN_PX + INBOX_DETAILS_COLUMN_PX;
export const INBOX_TWO_COLUMN_MIN_PX = INBOX_LIST_COLUMN_PX + INBOX_THREAD_MIN_PX;

export function pickInboxColumns(width: number): InboxColumns {
  if (width >= INBOX_THREE_COLUMN_MIN_PX) return 3;
  if (width >= INBOX_TWO_COLUMN_MIN_PX) return 2;
  return 1;
}
