/**
 * Merging a BROWSER's copy of another owner's conversation back into the stored row.
 *
 * A co-manager granted only some houses is handed a FILTERED copy of the owner's
 * thread (`restrictThreadToHouses`): the turns about houses they do not hold are
 * removed. Saving that copy wholesale - which any ordinary mailbox action does,
 * marking read included - wrote the filtered `messages` array back and deleted
 * the owner's turns for good. A client could equally restamp a turn's `houseId`
 * or invent a turn attributed to the owner.
 *
 * So for a row the caller does not own, the stored turns are the truth and the
 * body may only ADD: the same append-only rule the SMS mailbox path already
 * applies (`updateSmsNoticeMailboxState`), plus the handful of per-viewer
 * mailbox fields a browser legitimately owns.
 */

/** A synthetic root (`<threadId>-root`, or `merged:`) is derived at render time, never a stored turn. */
const DERIVED_MESSAGE_ID = /(?:^merged:|-root$)/;

type Turn = { id?: unknown; at?: unknown; body?: unknown };

function turns(value: unknown): Turn[] {
  return Array.isArray(value) ? (value as Turn[]) : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Turns the body carries that the stored row has never seen. */
function unseenTurns(stored: Record<string, unknown>, requested: Record<string, unknown>): Turn[] {
  const known = new Set<string>();
  const rootId = str(stored.rootMessageId);
  if (rootId) known.add(rootId);
  for (const turn of turns(stored.messages)) {
    const id = str(turn?.id);
    if (id) known.add(id);
  }
  return turns(requested.messages).filter((turn) => {
    const id = str(turn?.id);
    return Boolean(id) && !known.has(id) && !DERIVED_MESSAGE_ID.test(id);
  });
}

/**
 * The stored row with this viewer's mailbox state and their own new turns, and
 * nothing else from the body. Never removes or rewrites a stored turn.
 */
export function mergeOtherOwnersThreadRowData(
  storedRowData: unknown,
  requested: Record<string, unknown>,
): Record<string, unknown> {
  const stored = (storedRowData && typeof storedRowData === "object" && !Array.isArray(storedRowData)
    ? storedRowData
    : {}) as Record<string, unknown>;
  const appended = unseenTurns(stored, requested);
  const folder = ["inbox", "sent", "trash"].includes(String(requested.folder))
    ? requested.folder
    : stored.folder;
  const latest = appended[appended.length - 1];
  const latestBody = str(latest?.body);
  return {
    ...stored,
    folder,
    unread: typeof requested.unread === "boolean" ? requested.unread : stored.unread,
    ...(folder === "trash" && stored.folder !== "trash" ? { previousFolder: stored.folder } : {}),
    ...(appended.length ? { messages: [...turns(stored.messages), ...appended] } : {}),
    // The AI draft is browser-owned: an absent key means the viewer discarded it.
    aiDraft: requested.aiDraft,
    // A reply has to move the conversation up the list like any other turn.
    ...(str(latest?.at) ? { time: latest!.at } : {}),
    ...(latestBody ? { preview: latestBody.slice(0, 100).replace(/\n/g, " ") } : {}),
  };
}
