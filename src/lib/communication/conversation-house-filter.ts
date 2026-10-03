/**
 * D2 of comms-safety-0929, as pure code: a co-manager granted SOME houses who
 * opens a merged conversation sees only the messages about their houses.
 *
 *  - A turn that names a house shows when that house is granted.
 *  - A turn that names no house shows only to a viewer who holds EVERY house of
 *    that person (otherwise it could be about a house they were never granted).
 *  - An owner always sees everything; callers apply this only to another
 *    owner's thread.
 *
 * A thread written before turns carried a house (no `conversationKey`) is one
 * property thread: its row-level `propertyId` stands in for every unstamped turn.
 */

export type HouseGrantView = {
  /** Houses the viewer holds at the level asked, already narrowed to the active workspace. */
  allowed: ReadonlySet<string>;
  /** Every house the person is tied to with this owner. */
  personHouses: ReadonlySet<string>;
};

type Turn = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Does the viewer hold every house of the person? Unstamped turns show only then. */
export function viewerHoldsEveryHouse(view: HouseGrantView): boolean {
  if (view.personHouses.size === 0) return false;
  for (const house of view.personHouses) if (!view.allowed.has(house)) return false;
  return true;
}

/** The houses a stored thread's turns name (row-level house included for a legacy property thread). */
export function threadHouseIds(rowData: Record<string, unknown> | null | undefined): string[] {
  if (!rowData) return [];
  const out = new Set<string>();
  const keyed = str(rowData.conversationKey) !== "";
  const root = str(rowData.rootHouseId);
  if (root) out.add(root);
  if (!keyed) {
    const legacy = str(rowData.propertyId) || str(rowData.assignedPropertyId);
    if (legacy) out.add(legacy);
  }
  const messages = Array.isArray(rowData.messages) ? (rowData.messages as Turn[]) : [];
  for (const message of messages) {
    const house = str(message?.houseId);
    if (house) out.add(house);
  }
  return [...out];
}

/**
 * The thread as this viewer may read it, or `null` when no turn of it is theirs.
 * Returns the SAME object when nothing is hidden.
 */
export function restrictThreadToHouses(
  rowData: Record<string, unknown>,
  view: HouseGrantView,
): Record<string, unknown> | null {
  const keyed = str(rowData.conversationKey) !== "";
  const legacyHouse = keyed ? "" : str(rowData.propertyId) || str(rowData.assignedPropertyId);
  const untaggedOk = viewerHoldsEveryHouse(view);
  const visible = (house: string): boolean => {
    const effective = house || legacyHouse;
    return effective ? view.allowed.has(effective) : untaggedOk;
  };

  const messages = Array.isArray(rowData.messages) ? (rowData.messages as Turn[]) : [];
  const rootVisible = visible(str(rowData.rootHouseId));
  const kept = messages.filter((message) => visible(str(message?.houseId)));
  if (rootVisible && kept.length === messages.length) return rowData;

  let next: Record<string, unknown>;
  if (rootVisible) {
    next = { ...rowData, messages: kept };
  } else {
    const [first, ...rest] = kept;
    if (!first) return null;
    next = {
      ...rowData,
      body: first.body ?? "",
      from: first.from ?? rowData.from,
      rootAt: first.at,
      rootMessageId: first.id,
      rootChannel: first.channel,
      rootSubject: first.subject,
      rootOutbound: first.outbound === true,
      rootHouseId: first.houseId,
      rootDelivery: first.delivery,
      rootAutomated: first.automated,
      attachments: first.attachments,
      messages: rest,
    };
  }
  const turns = Array.isArray(next.messages) ? (next.messages as Turn[]) : [];
  const latest = turns[turns.length - 1];
  const latestBody = str(latest?.body) || str(next.body);
  return {
    ...next,
    preview: latestBody.slice(0, 100).replace(/\n/g, " "),
    ...(latest?.at ? { time: latest.at } : {}),
    housesRestricted: true,
  };
}
