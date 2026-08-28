/**
 * Browser callers for the two confirmed-tour actions.
 *
 * Both go through server routes rather than the local schedule store on
 * purpose: cancelling or moving a confirmed tour has to reach the GUEST (email,
 * inbox thread, consent-gated SMS) and the manager's linked Google Calendar,
 * and none of that can happen from a client-side array rewrite. `Delete event`
 * did exactly that rewrite, which is why a cancelled tour reached nobody.
 */

export type TourGuestNotification = { ok: boolean; skipped?: boolean; error?: string } | null;

type ChangeResult = {
  ok: boolean;
  message?: string;
  error?: string;
  guestNotification?: TourGuestNotification;
  /** The manager's linked Google Calendar; a failure here is reported, not fatal. */
  calendarSync?: TourGuestNotification;
};

/**
 * Did the guest actually hear about the change?
 *
 * The ONE read of that question, because `ok` alone is not it: a delivery that
 * errored can still carry `ok: true` from an older shape, and an `error` is a
 * failure however the flag reads. A deliberate `skipped` (sandbox address, no
 * mail provider) is NOT a failure and must stay out of this.
 */
export function tourGuestNotificationFailed(notification: TourGuestNotification | undefined): boolean {
  if (!notification) return false;
  return notification.ok === false || Boolean(notification.error);
}

async function postTourChange(path: string, body: Record<string, unknown>): Promise<ChangeResult> {
  try {
    const res = await fetch(path, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as ChangeResult;
    if (!res.ok) return { ok: false, error: data.error ?? "That did not go through. Try again." };
    return { ...data, ok: true };
  } catch {
    return { ok: false, error: "Could not reach the server. Check your connection and try again." };
  }
}

export function cancelPlannedTourFromServer(input: {
  plannedEventId: string;
  reason?: string;
  notifyGuest?: boolean;
  subject?: string;
  body?: string;
}): Promise<ChangeResult> {
  return postTourChange("/api/portal-tour-inquiries/cancel", {
    id: input.plannedEventId,
    reason: input.reason,
    notifyGuest: input.notifyGuest !== false,
    subject: input.subject,
    body: input.body,
    messageBody: input.body,
  });
}

export function proposePendingTourRescheduleFromServer(input: {
  inquiryId: string;
  previousStart: string;
  previousEnd: string;
  start: string;
  end: string;
  notifyGuest?: boolean;
  subject?: string;
  body?: string;
}): Promise<ChangeResult> {
  return postTourChange("/api/portal-tour-inquiries/propose-reschedule", {
    id: input.inquiryId,
    previousStart: input.previousStart,
    previousEnd: input.previousEnd,
    start: input.start,
    end: input.end,
    notifyGuest: input.notifyGuest !== false,
    subject: input.subject,
    body: input.body,
    messageBody: input.body,
  });
}

export function reschedulePlannedTourFromServer(input: {
  plannedEventId: string;
  start: string;
  end: string;
  reason?: string;
  notifyGuest?: boolean;
}): Promise<ChangeResult> {
  return postTourChange("/api/portal-tour-inquiries/reschedule", {
    id: input.plannedEventId,
    start: input.start,
    end: input.end,
    reason: input.reason,
    notifyGuest: input.notifyGuest !== false,
  });
}
