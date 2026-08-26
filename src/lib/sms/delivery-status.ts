const STATUS_RANK: Readonly<Record<string, number>> = {
  queued: 10,
  accepted: 15,
  scheduled: 15,
  sending: 20,
  sent: 30,
  delivered: 40,
  read: 50,
  failed: 40,
  undelivered: 40,
  canceled: 40,
};

const TERMINAL = new Set(["delivered", "read", "failed", "undelivered", "canceled"]);

export function twilioStatusRank(status: string | null | undefined): number {
  return STATUS_RANK[String(status ?? "").trim().toLowerCase()] ?? 0;
}

/** A terminal outcome is immutable; otherwise callbacks may only advance. */
export function shouldApplyTwilioStatus(
  current: string | null | undefined,
  candidate: string | null | undefined,
): boolean {
  const from = String(current ?? "").trim().toLowerCase();
  const to = String(candidate ?? "").trim().toLowerCase();
  if (!to) return false;
  if (!from) return true;
  if (from === to) return true;
  if (TERMINAL.has(from)) return false;
  return twilioStatusRank(to) >= twilioStatusRank(from);
}

export function outboxStatusForTwilio(status: string):
  | "submitted"
  | "sent"
  | "delivered"
  | "failed" {
  const normalized = status.trim().toLowerCase();
  if (normalized === "delivered" || normalized === "read") return "delivered";
  if (normalized === "failed" || normalized === "undelivered" || normalized === "canceled") return "failed";
  if (normalized === "sent") return "sent";
  return "submitted";
}

