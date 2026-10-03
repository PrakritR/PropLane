/**
 * Merging a BROWSER's copy of a stored conversation back into the row.
 *
 * Conversation history is APPEND-ONLY, for the owner as much as for a
 * co-manager. A save may add turns and change the per-viewer mailbox fields;
 * it can never remove, reorder or rewrite a turn the server already holds.
 * Editing or clearing history goes through its own explicit action.
 *
 * Two things made that necessary:
 *
 *  - a co-manager granted only some houses is handed a FILTERED copy
 *    (`restrictThreadToHouses`), so saving it wholesale - which marking it read
 *    does - wrote the filtered `messages` array back and deleted the owner's
 *    turns for good;
 *  - a body is a client's claim about history, so a wholesale write could edit
 *    a resident's inbound message or delete it, on the owner's own thread too.
 *
 * On another owner's thread the turns a delegate may ADD are narrowed further:
 * only their own OUTGOING turns, only about houses they hold. An inbound turn
 * is the counterparty speaking, which no co-manager may author.
 */

/** A synthetic root (`<threadId>-root`, or `merged:`) is derived at render time, never a stored turn. */
const DERIVED_MESSAGE_ID = /(?:^merged:|-root$)/;

type Turn = Record<string, unknown>;

/**
 * Who is saving, and what they may add.
 *
 *  - `owner`: the row is theirs (or an unowned admin row). Append-only, no
 *    further narrowing - the server writes into this thread too.
 *  - `delegate`: another owner's conversation, reached through a Communication
 *    grant. Only their own outgoing turns, only about `allowedHouses`.
 */
export type ThreadAppendRule =
  | { kind: "owner" }
  | { kind: "delegate"; allowedHouses: ReadonlySet<string>; authorUserId: string };

export type ThreadMergeResult =
  | { ok: true; rowData: Record<string, unknown> }
  | { ok: false; reason: "inbound_turn_not_authorable" | "house_not_granted" };

function turns(value: unknown): Turn[] {
  return Array.isArray(value) ? (value as Turn[]) : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Every message id a row already accounts for, its derived root included. */
export function storedThreadMessageIds(rowData: unknown): string[] {
  const row = asRecord(rowData);
  const out: string[] = [];
  const rootId = str(row.rootMessageId);
  if (rootId) out.push(rootId);
  for (const turn of turns(row.messages)) {
    const id = str(turn?.id);
    if (id) out.push(id);
  }
  return out;
}

/**
 * Turns the body carries that no row of this conversation has seen.
 *
 * `knownElsewhere` is what the list's person-collapse makes necessary: the GET
 * folds several stored rows into one, so the body legitimately carries sibling
 * rows' turns. Appending those to the canonical row would duplicate them.
 */
function unseenTurns(
  stored: Record<string, unknown>,
  requested: Record<string, unknown>,
  knownElsewhere: Iterable<string> | undefined,
): Turn[] {
  const known = new Set<string>(storedThreadMessageIds(stored));
  for (const id of knownElsewhere ?? []) {
    const clean = str(id);
    if (clean) known.add(clean);
  }
  return turns(requested.messages).filter((turn) => {
    const id = str(turn?.id);
    return Boolean(id) && !known.has(id) && !DERIVED_MESSAGE_ID.test(id);
  });
}

/** A delegate's appended turn, checked and stamped — or the reason it is refused. */
function authorDelegateTurn(
  turn: Turn,
  rule: Extract<ThreadAppendRule, { kind: "delegate" }>,
): { ok: true; turn: Turn } | { ok: false; reason: "inbound_turn_not_authorable" | "house_not_granted" } {
  if (turn.outbound !== true) return { ok: false, reason: "inbound_turn_not_authorable" };
  const houseId = str(turn.houseId);
  if (houseId && !rule.allowedHouses.has(houseId)) return { ok: false, reason: "house_not_granted" };
  return { ok: true, turn: { ...turn, authorUserId: rule.authorUserId } };
}

/**
 * The stored row with this viewer's mailbox state and whatever turns they are
 * allowed to add, and nothing else from the body.
 */
export function mergeInboxThreadRowData(input: {
  stored: unknown;
  requested: Record<string, unknown>;
  rule: ThreadAppendRule;
  /** Message ids held by this conversation's OTHER rows (a collapsed group). */
  knownElsewhere?: Iterable<string>;
}): ThreadMergeResult {
  const stored = asRecord(input.stored);
  const requested = input.requested;
  const candidates = unseenTurns(stored, requested, input.knownElsewhere);

  const appended: Turn[] = [];
  for (const candidate of candidates) {
    if (input.rule.kind === "owner") {
      appended.push(candidate);
      continue;
    }
    const authored = authorDelegateTurn(candidate, input.rule);
    if (!authored.ok) return { ok: false, reason: authored.reason };
    appended.push(authored.turn);
  }

  const folder = ["inbox", "sent", "trash"].includes(String(requested.folder))
    ? requested.folder
    : stored.folder;
  const latest = appended[appended.length - 1];
  const latestBody = str(latest?.body);
  return {
    ok: true,
    rowData: {
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
    },
  };
}

/** The row an explicit Clear leaves behind: the conversation stays, its turns go. */
export function clearedInboxThreadRowData(
  storedRowData: unknown,
  placeholder: { preview?: string; subject?: string; from?: string },
): Record<string, unknown> {
  const stored = asRecord(storedRowData);
  const next: Record<string, unknown> = {
    ...stored,
    messages: [],
    body: "",
    preview: str(placeholder.preview),
    unread: false,
    time: "",
    subject: str(placeholder.subject) || stored.subject,
    from: str(placeholder.from) || stored.from,
  };
  delete next.aiDraft;
  delete next.aiDraftQueue;
  delete next.rootMessageId;
  return next;
}
