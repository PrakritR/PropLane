/**
 * Browser callers for the two confirmed-tour actions.
 *
 * Both go through server routes rather than the local schedule store on
 * purpose: cancelling or moving a confirmed tour has to reach the GUEST (email,
 * inbox thread, consent-gated SMS) and the manager's linked Google Calendar,
 * and none of that can happen from a client-side array rewrite. `Delete event`
 * did exactly that rewrite, which is why a cancelled tour reached nobody.
 */

export type TourChannelOutcome = {
  requested: boolean;
  sent: boolean;
  accepted?: boolean;
  skipped: boolean;
  error?: string;
};
export type TourGuestNotification = {
  ok: boolean;
  skipped?: boolean;
  error?: string;
  email?: TourChannelOutcome;
  sms?: TourChannelOutcome;
  inbox?: { sent: boolean; error?: string };
} | null;

export function tourGuestNotificationSummary(notification: TourGuestNotification | undefined): string {
  if (!notification) return "the selected channels";
  const channels: string[] = notification.inbox?.sent ? ["PropLane inbox"] : [];
  if (notification.email?.sent) channels.push("email");
  if (notification.sms?.sent) channels.push("SMS");
  else if (notification.sms?.accepted) channels.push("queued SMS");
  return channels.join(", ") || "the selected channels";
}

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
  const requestedSmsMissing = Boolean(
    notification.sms?.requested && !notification.sms.sent && !notification.sms.accepted,
  );
  const requestedEmailMissing = Boolean(
    notification.email?.requested && !notification.email.sent && !notification.email.skipped,
  );
  return notification.ok === false || Boolean(notification.error) || requestedSmsMissing || requestedEmailMissing;
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
  deliverViaEmail?: boolean;
  deliverViaSms?: boolean;
}): Promise<ChangeResult> {
  return postTourChange("/api/portal-tour-inquiries/cancel", {
    id: input.plannedEventId,
    reason: input.reason,
    notifyGuest: input.notifyGuest !== false,
    subject: input.subject,
    body: input.body,
    messageBody: input.body,
    ...(input.deliverViaEmail === undefined ? {} : { deliverViaEmail: input.deliverViaEmail }),
    ...(input.deliverViaSms === undefined ? {} : { deliverViaSms: input.deliverViaSms }),
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
  deliverViaEmail?: boolean;
  deliverViaSms?: boolean;
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
    ...(input.deliverViaEmail === undefined ? {} : { deliverViaEmail: input.deliverViaEmail }),
    ...(input.deliverViaSms === undefined ? {} : { deliverViaSms: input.deliverViaSms }),
  });
}

export function reschedulePlannedTourFromServer(input: {
  plannedEventId: string;
  start: string;
  end: string;
  reason?: string;
  notifyGuest?: boolean;
  subject?: string;
  body?: string;
  deliverViaEmail?: boolean;
  deliverViaSms?: boolean;
}): Promise<ChangeResult> {
  return postTourChange("/api/portal-tour-inquiries/reschedule", {
    id: input.plannedEventId,
    start: input.start,
    end: input.end,
    reason: input.reason,
    notifyGuest: input.notifyGuest !== false,
    subject: input.subject,
    body: input.body,
    messageBody: input.body,
    ...(input.deliverViaEmail === undefined ? {} : { deliverViaEmail: input.deliverViaEmail }),
    ...(input.deliverViaSms === undefined ? {} : { deliverViaSms: input.deliverViaSms }),
  });
}
