/** Human-readable label from a `manager_property_records` row (server-side). */
export function labelFromManagerPropertyRecordRow(row: {
  property_data?: unknown;
  row_data?: unknown;
  id?: string;
}): string {
  const pd = (row.property_data ?? row.row_data ?? {}) as Record<string, unknown>;
  const building = String(pd.buildingName ?? pd.title ?? pd.address ?? "").trim();
  const unit = String(pd.unitLabel ?? "").trim();
  const roomCountRaw = pd.roomCount ?? (Array.isArray(pd.rooms) ? pd.rooms.length : null);
  const roomCount = typeof roomCountRaw === "number" && roomCountRaw > 0 ? roomCountRaw : null;
  const roomsSuffix = roomCount != null ? `${roomCount} rooms` : "";

  if (building && unit) return `${building} · ${unit}`;
  if (building && roomsSuffix) return `${building} · ${roomsSuffix}`;
  if (building) return building;
  if (roomsSuffix) return roomsSuffix;
  return String(row.id ?? "Property");
}
