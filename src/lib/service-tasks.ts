/**
 * The checklist a manager attaches to a service when logging it — "Check
 * supply lines", "Replace cartridge if worn". One shape for maintenance work
 * orders and add-on service requests, stored in each record's `row_data`.
 */
export type ServiceTask = { id: string; title: string; done: boolean };

export function serviceTasksFromTitles(titles: readonly string[]): ServiceTask[] {
  return titles
    .map((title) => title.trim())
    .filter(Boolean)
    .map((title, index) => ({ id: `task_${Date.now().toString(36)}_${index}`, title, done: false }));
}

export function normalizeServiceTasks(raw: unknown): ServiceTask[] {
  if (!Array.isArray(raw)) return [];
  const out: ServiceTask[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const title = typeof row.title === "string" ? row.title.trim() : "";
    if (!title) continue;
    out.push({
      id: typeof row.id === "string" && row.id.trim() ? row.id : `task_${out.length}`,
      title,
      done: row.done === true,
    });
  }
  return out;
}

/** "$80", "80", "80.50" → cents; anything else → null. */
export function parseResidentChargeCents(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  const amount = Number(cleaned);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount * 100);
}
