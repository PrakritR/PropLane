/**
 * The one ⋯ menu order (PLAN-0920-1058 area 1d).
 *
 * A record's ⋯ always reads: Open · the record's own actions (max four) ·
 * Message <person> · Copy link / Share · — divider — · Archive · Delete. This
 * module sorts a flat action list into that shape; it never renders anything
 * — `RecordActionMenu` (`src/components/ui/record-action-menu.tsx`) is the
 * one place that turns the order into markup.
 *
 * "Open" is not part of the items this function sorts — every menu already
 * puts it first on its own via `RecordActionMenu`'s `onOpen` prop, ahead of
 * anything from a record's own registry entry
 * (`src/lib/portals/record-sections.ts` → `headerActions`).
 */

/** The minimum shape `orderRecordActions` needs from a menu action. */
export type RecordActionOrderItem = {
  /** Matched case-insensitively against the well-known trailing ids below. */
  id: string;
  /**
   * Undoable in one click (an Undo toast covers it) — it runs immediately.
   * Missing or `false` means it cannot be undone in one click and must go
   * through the existing confirm path before it fires (AGENTS.md → "Every
   * mutation in a ⋯ menu that cannot be undone in one click confirms").
   */
  reversible?: boolean;
};

export type RecordActionOrderCategory = "own" | "message" | "link" | "archive" | "delete";

/** How many of a record's own (non-trailing) actions the menu shows before the trio. */
export const MAX_OWN_RECORD_ACTIONS = 4;

const CATEGORY_BY_ID: Record<string, RecordActionOrderCategory> = {
  message: "message",
  "message-resident": "message",
  "message-vendor": "message",
  "copy-link": "link",
  copylink: "link",
  copy: "link",
  "copy link": "link",
  share: "link",
  "share-link": "link",
  archive: "archive",
  delete: "delete",
  remove: "delete",
};

/** Which of the trailing categories (or "own") a raw action id belongs to. */
export function classifyRecordActionId(id: string): RecordActionOrderCategory {
  return CATEGORY_BY_ID[id.trim().toLowerCase()] ?? "own";
}

/** Whether this id sits after the divider — the menu's own actions never do. */
export function isPostDividerRecordActionId(id: string): boolean {
  const category = classifyRecordActionId(id);
  return category === "archive" || category === "delete";
}

/**
 * Sort a record's ⋯ actions into the one canonical order. "Own" actions (any
 * id that is not `message`, `copy`/`share`, `archive`, or `delete`) keep
 * their given relative order and are capped at {@link MAX_OWN_RECORD_ACTIONS}
 * — a kind that declares more than four in its registry entry is a content
 * bug, not something the menu should grow to fit.
 */
export function orderRecordActions<T extends RecordActionOrderItem>(items: T[]): T[] {
  const groups: Record<RecordActionOrderCategory, T[]> = {
    own: [],
    message: [],
    link: [],
    archive: [],
    delete: [],
  };
  for (const item of items) {
    groups[classifyRecordActionId(item.id)].push(item);
  }
  return [
    ...groups.own.slice(0, MAX_OWN_RECORD_ACTIONS),
    ...groups.message,
    ...groups.link,
    ...groups.archive,
    ...groups.delete,
  ];
}
