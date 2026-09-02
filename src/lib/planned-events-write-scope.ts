type PlannedEventLike = Record<string, unknown> & { id?: unknown; managerUserId?: unknown };

function eventsFromRecord(record: Record<string, unknown> | null | undefined): PlannedEventLike[] {
  const rowData = record?.row_data;
  if (!rowData || typeof rowData !== "object" || Array.isArray(rowData)) return [];
  const payload = (rowData as Record<string, unknown>).payload;
  return Array.isArray(payload)
    ? payload.filter((event): event is PlannedEventLike => Boolean(event && typeof event === "object" && !Array.isArray(event)))
    : [];
}

/**
 * The planned-events singleton is shared for calendar reads. A manager may
 * replace only their own slice; other managers' events are copied from the
 * server row and can never be changed or deleted by client JSON.
 */
export function reconcileManagerPlannedEventsWrite(
  record: Record<string, unknown>,
  managerUserId: string,
  existing: Record<string, unknown> | null,
): Record<string, unknown> {
  const rowData = record.row_data;
  if (!rowData || typeof rowData !== "object" || Array.isArray(rowData)) return record;

  const storedEvents = eventsFromRecord(existing);
  const protectedEvents = storedEvents.filter(
    (event) => String(event.managerUserId ?? "").trim() !== managerUserId,
  );
  const protectedIds = new Set(protectedEvents.map((event) => String(event.id ?? "").trim()).filter(Boolean));
  const incomingPayload = (rowData as Record<string, unknown>).payload;
  const ownedEvents = (Array.isArray(incomingPayload) ? incomingPayload : [])
    .filter((event): event is PlannedEventLike => Boolean(event && typeof event === "object" && !Array.isArray(event)))
    .filter((event) => !protectedIds.has(String(event.id ?? "").trim()))
    .filter((event) => {
      const claimed = String(event.managerUserId ?? "").trim();
      return !claimed || claimed === managerUserId;
    })
    .map((event) => ({ ...event, managerUserId }));

  return {
    ...record,
    row_data: {
      ...(rowData as Record<string, unknown>),
      payload: [...protectedEvents, ...ownedEvents],
    },
  };
}
