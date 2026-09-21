"use client";

/** Client-side call into `/api/portal-bookings/invite-resident` (src/lib/booking-resident-invite.server.ts). */

export type BookingResidentInviteClientResult =
  | { ok: true; channel: "sms" | "email"; attachedExisting: boolean; axisId: string; message: string }
  | { ok: false; error: string };

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.trim()) return body.error;
  } catch {
    // not JSON
  }
  return fallback;
}

export async function sendBookingResidentInviteRequest(input: {
  blockId: string;
  propertyId: string;
  propertyLabel: string;
  residentName: string;
  residentEmail: string;
  residentPhone: string;
}): Promise<BookingResidentInviteClientResult> {
  const res = await fetch("/api/portal-bookings/invite-resident", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    return { ok: false, error: await readError(res, "Could not send the invite.") };
  }
  return (await res.json()) as BookingResidentInviteClientResult;
}
