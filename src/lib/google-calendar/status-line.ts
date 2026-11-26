/** What the Integrations Google Calendar row says, from what the status read actually returned. */
export type GoogleCalendarStatusLoad =
  | { state: "loading" }
  | { state: "error"; message: string }
  | {
      state: "ready";
      connected: boolean;
      email: string | null;
      revoked?: boolean;
      configured?: boolean;
      lastSyncedAt?: string | null;
    };

/** A status read that has not answered by now is an error, never a permanent "Loading…". */
export const GOOGLE_CALENDAR_STATUS_TIMEOUT_MS = 10_000;

function syncedText(iso: string | null | undefined, now: Date): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (at.toDateString() === now.toDateString()) return time;
  return `${at.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

/** "Connected · a@b.com · last sync 8:04 AM", "Not connected", "Reconnect needed", or the read's own error. */
export function googleCalendarStatusLine(load: GoogleCalendarStatusLoad, now: Date = new Date()): string {
  if (load.state === "loading") return "Loading…";
  if (load.state === "error") return load.message;
  if (load.connected) {
    const sync = syncedText(load.lastSyncedAt, now);
    return ["Connected", load.email, sync ? `last sync ${sync}` : ""].filter(Boolean).join(" · ");
  }
  if (load.revoked) return "Reconnect needed · Google access ended";
  return "Not connected";
}
