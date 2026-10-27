/**
 * How many columns Communication draws, picked from the width of the
 * Communication surface itself (never the viewport, so the docked assistant, the
 * sidebar and full screen all count with no special cases).
 *
 *   2: list 320 · thread (440+)                  760px and up
 *   1: the thread alone (list alone when none is open) under 760px
 *
 * There is no third column (captain, Oct 27: the chat was squeezed by a fixed 280px
 * contact column). The contact details open on demand from the info icon in the
 * thread header, as a panel over the thread's right edge, at every width.
 */
export type InboxColumns = 2 | 1;

export const INBOX_LIST_COLUMN_PX = 320;
export const INBOX_THREAD_MIN_PX = 440;
/** Width of the contact-details panel that opens over the thread. */
export const INBOX_DETAILS_PANEL_PX = 280;
export const INBOX_TWO_COLUMN_MIN_PX = INBOX_LIST_COLUMN_PX + INBOX_THREAD_MIN_PX;
/** Full screen centres the conversation at this readable width. */
export const INBOX_FULL_SCREEN_THREAD_MAX_PX = 760;

export function pickInboxColumns(width: number): InboxColumns {
  return width >= INBOX_TWO_COLUMN_MIN_PX ? 2 : 1;
}
