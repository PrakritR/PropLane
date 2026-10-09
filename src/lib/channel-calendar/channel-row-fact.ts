/** Relative "x min ago" for the Bookings row; falls back to "—" when never synced. */
export function relativeSyncTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  const mins = Math.max(0, Math.round((now - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} d ago`;
}

/** The fact line under a live channel row: "Connected · 2 of 3 rooms · both ways · synced 5 min ago · 1 needs a listing". */
export function channelRowFact(input: { linked: number; total: number; lastSyncedAt?: string | null; now?: number }): string {
  const { linked, total } = input;
  if (!linked || total <= 0) return "";
  const shown = Math.min(linked, total);
  let fact = `Connected · ${shown} of ${total} ${total === 1 ? "room" : "rooms"} · both ways`;
  if (input.lastSyncedAt) fact += ` · synced ${relativeSyncTime(input.lastSyncedAt, input.now)}`;
  if (shown < total) fact += ` · ${total - shown} ${total - shown === 1 ? "needs" : "need"} a listing`;
  return fact;
}
