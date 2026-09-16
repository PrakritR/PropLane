/**
 * A resident's own text settings — pure, so the Preferences pane can import
 * it without dragging the server-side delivery chain into the client bundle.
 */
/**
 * A resident's own quiet window for texts, Pacific wall clock (PLAN-0915).
 * Inbox and email are never held; a text that would land inside the window is
 * simply not sent as a text — the inbox row and the email still arrive.
 */
export type ResidentTextSettings = {
  quietHours: { enabled: boolean; startHour: number; endHour: number };
};

export const DEFAULT_RESIDENT_TEXT_SETTINGS: ResidentTextSettings = {
  quietHours: { enabled: false, startHour: 21, endHour: 8 },
};

export function normalizeResidentTextSettings(raw: unknown): ResidentTextSettings {
  const row = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const quiet = row.quietHours && typeof row.quietHours === "object" && !Array.isArray(row.quietHours) ? (row.quietHours as Record<string, unknown>) : {};
  const hour = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 23 ? Math.round(value) : fallback;
  const startHour = hour(quiet.startHour, DEFAULT_RESIDENT_TEXT_SETTINGS.quietHours.startHour);
  const endHour = hour(quiet.endHour, DEFAULT_RESIDENT_TEXT_SETTINGS.quietHours.endHour);
  return { quietHours: { enabled: quiet.enabled === true && startHour !== endHour, startHour, endHour } };
}

