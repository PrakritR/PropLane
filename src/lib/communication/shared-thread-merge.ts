/**
 * Merging a BROWSER's copy of a stored conversation back into the row.
 *
 * Conversation history is APPEND-ONLY, whoever is saving. A save may add turns
 * and change the per-viewer mailbox fields; it can never remove, reorder or
 * rewrite a turn the server already holds. Clearing history is its own
 * explicit, audited action.
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
 * A turn added to a row the caller does NOT own is attributed by the SERVER,
 * never by the body: `from`, `outbound` and the house come from who the caller
 * is to that conversation. `from` is the field a human reads as the sender, so
 * trusting it let a co-manager write a turn that displays as the owner speaking.
 */

/** A synthetic root (`<threadId>-root`, or `merged:`) is derived at render time, never a stored turn. */
const DERIVED_MESSAGE_ID = /(?:^merged:|-root$)/;

/** How many cleared-turn tombstones a row keeps. Enough to outlive any stale tab. */
const MAX_CLEARED_TOMBSTONES = 500;

type Turn = Record<string, unknown>;

/**
 * Who is saving, and what they may add.
 *
 *  - `owner`: the row is theirs (or an unowned legacy / admin row). Append-only,
 *    no further narrowing - the server writes into this thread too.
 *  - `delegate`: another owner's conversation, reached through a Communication
 *    grant. They speak for the management side, so only OUTGOING turns, only
 *    about a house they hold.
 *  - `participant`: the person the conversation is WITH, on a row the other
 *    party owns (a resident or vendor on a manager-owned thread). They are the
 *    counterparty, so their turn is inbound from the owner's point of view and
 *    they may never author the owner's side.
 */
export type ThreadAppendRule =
  | { kind: "owner" }
  | {
      kind: "delegate";
      allowedHouses: ReadonlySet<string>;
      /** The houses this conversation is already about, used to stamp an untagged turn. */
      conversationHouseIds: readonly string[];
      authorUserId: string;
      authorName: string;
    }
  | {
      kind: "participant";
      authorUserId: string;
      authorName: string;
      /** The house the conversation is about, stamped on the appended turn when there is one. */
      conversationHouseId: string;
    };

export type ThreadMergeRefusal = "inbound_turn_not_authorable" | "owner_turn_not_authorable" | "house_not_granted";

export type ThreadMergeResult =
  | { ok: true; rowData: Record<string, unknown> }
  | { ok: false; reason: ThreadMergeRefusal };

function turns(value: unknown): Turn[] {
  return Array.isArray(value) ? (value as Turn[]) : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => str(item)).filter(Boolean) : [];
}

/**
 * Every message id a row already accounts for: its turns, its derived root, and
 * the turns an explicit Clear removed.
 *
 * The tombstones are what makes a Clear durable. Without them a cleared row
 * knows nothing, so a second tab still holding the pre-clear copy re-appended
 * every turn on its next ordinary save.
 */
export function storedThreadMessageIds(rowData: unknown): string[] {
  const row = asRecord(rowData);
  const out: string[] = [];
  const rootId = str(row.rootMessageId);
  if (rootId) out.push(rootId);
  for (const turn of turns(row.messages)) {
    const id = str(turn?.id);
    if (id) out.push(id);
  }
  out.push(...stringList(row.clearedMessageIds));
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

/**
 * The house a delegate's appended turn is about.
 *
 * This is the WRITE side of the D2 read rule, and it mirrors it: an untagged
 * turn is only ever readable by a viewer who holds every house of that
 * conversation, so an untagged turn may only be WRITTEN by one. A delegate who
 * holds only some of the houses must name one of theirs - which the composer
 * does for them, since a restricted thread already shows them only the houses
 * they hold.
 */
function delegateHouseFor(
  turn: Turn,
  rule: Extract<ThreadAppendRule, { kind: "delegate" }>,
): { ok: true; houseId: string } | { ok: false } {
  // A grant on no house at all holds nothing: there is nothing to add.
  if (rule.allowedHouses.size === 0) return { ok: false };
  const named = str(turn.houseId);
  if (named) return rule.allowedHouses.has(named) ? { ok: true, houseId: named } : { ok: false };

  const conversation = [...new Set(rule.conversationHouseIds.map((id) => str(id)).filter(Boolean))];
  const mine = conversation.filter((id) => rule.allowedHouses.has(id));
  if (mine.length === 1) return { ok: true, houseId: mine[0]! };
  // They hold every house the conversation names, so an untagged turn is theirs
  // to write - exactly the viewers the read rule shows it to.
  if (conversation.length > 0 && mine.length === conversation.length) return { ok: true, houseId: "" };
  // The conversation names no house at all (a thread written before turns
  // carried one): there is nothing to attribute and nothing to withhold.
  if (conversation.length === 0) {
    return rule.allowedHouses.size === 1
      ? { ok: true, houseId: [...rule.allowedHouses][0]! }
      : { ok: true, houseId: "" };
  }
  return { ok: false };
}

/** A turn appended to someone else's row, attributed by the server — or the reason it is refused. */
function authorForeignTurn(
  turn: Turn,
  rule: Exclude<ThreadAppendRule, { kind: "owner" }>,
): { ok: true; turn: Turn } | { ok: false; reason: ThreadMergeRefusal } {
  if (rule.kind === "participant") {
    // They are the counterparty: from the owner's point of view this is inbound,
    // and the owner's own side is never theirs to write.
    return {
      ok: true,
      turn: {
        ...turn,
        from: rule.authorName,
        outbound: false,
        authorUserId: rule.authorUserId,
        ...(rule.conversationHouseId ? { houseId: rule.conversationHouseId } : {}),
      },
    };
  }
  if (turn.outbound !== true) return { ok: false, reason: "inbound_turn_not_authorable" };
  const house = delegateHouseFor(turn, rule);
  if (!house.ok) return { ok: false, reason: "house_not_granted" };
  return {
    ok: true,
    turn: {
      ...turn,
      from: rule.authorName,
      outbound: true,
      authorUserId: rule.authorUserId,
      ...(house.houseId ? { houseId: house.houseId } : {}),
    },
  };
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
    const authored = authorForeignTurn(candidate, input.rule);
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

/**
 * The row an explicit Clear leaves behind: the conversation stays, its turns go.
 *
 * The ids it removed are kept as tombstones so the append-only merge still
 * knows them - a tab that was holding the pre-clear copy would otherwise put
 * every cleared turn straight back on its next save.
 */
export function clearedInboxThreadRowData(
  storedRowData: unknown,
  placeholder: { preview?: string; subject?: string; from?: string },
  clearedAtIso = new Date().toISOString(),
): Record<string, unknown> {
  const stored = asRecord(storedRowData);
  // The ids this Clear is removing come LAST, so the cap drops the oldest
  // tombstones rather than the turns being cleared right now.
  const removedNow = [str(stored.rootMessageId), ...turns(stored.messages).map((turn) => str(turn?.id))].filter(
    Boolean,
  );
  const tombstones = [...new Set([...stringList(stored.clearedMessageIds), ...removedNow])].slice(
    -MAX_CLEARED_TOMBSTONES,
  );
  const next: Record<string, unknown> = {
    ...stored,
    messages: [],
    body: "",
    preview: str(placeholder.preview),
    unread: false,
    time: "",
    subject: str(placeholder.subject) || stored.subject,
    from: str(placeholder.from) || stored.from,
    clearedAt: clearedAtIso,
    ...(tombstones.length ? { clearedMessageIds: tombstones } : {}),
  };
  delete next.aiDraft;
  delete next.aiDraftQueue;
  delete next.rootMessageId;
  return next;
}
