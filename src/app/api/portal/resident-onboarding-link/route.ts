import { NextResponse } from "next/server";
import { resolveListingChannelContext } from "@/lib/listing-channels/route-context.server";
import { grantCoversHouse, resolveCommunicationGrant } from "@/lib/one-number/communication-grant.server";
import { sendOnboardingLink } from "@/lib/resident-onboarding-link/send.server";
import { loadOnboardingFacts } from "@/lib/resident-onboarding-link/sources.server";

export const runtime = "nodejs";

const REFUSALS: Record<string, { status: number; error: string }> = {
  not_found: { status: 404, error: "Record not found." },
  not_ready: { status: 409, error: "Approve the application or confirm the booking first." },
  no_phone: { status: 409, error: "There is no phone number on this record." },
  not_consented: { status: 409, error: "This person has not agreed to texts." },
  rate_limited: { status: 429, error: "A link was just sent. Wait a few minutes." },
  send_failed: { status: 502, error: "The text could not be sent." },
  unreadable: { status: 503, error: "Could not read the record. Try again." },
};

/**
 * "Text onboarding link": POST `{ applicationId } | { bookingId }`. The workspace comes from the signed-in manager;
 * the record is re-read in it and its house must be one this person holds Communication on at `edit`. The phone
 * the text goes to is the one on the record, never one from the body.
 */
export async function POST(request: Request) {
  let body: { applicationId?: unknown; bookingId?: unknown; workspaceId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const ctx = await resolveListingChannelContext(request, typeof body.workspaceId === "string" ? body.workspaceId : null).catch(() => null);
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const access = await resolveCommunicationGrant(ctx.db, ctx.userId, ctx.workspace, "edit");
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  const { isManagedReadOnly } = await import("@/lib/auth/managed-read-only.server");
  if (await isManagedReadOnly(ctx.db, ctx.userId, ctx.workspace.id)) {
    return NextResponse.json({ error: "This workspace is view-only for you." }, { status: 403 });
  }

  const applicationId = typeof body.applicationId === "string" ? body.applicationId.trim() : "";
  const bookingId = typeof body.bookingId === "string" ? body.bookingId.trim() : "";
  if (Boolean(applicationId) === Boolean(bookingId)) return NextResponse.json({ error: "Name an application or a booking." }, { status: 400 });
  const kind = applicationId ? ("application" as const) : ("booking" as const);
  const id = applicationId || bookingId;

  const loaded = await loadOnboardingFacts(ctx.db, { workspaceId: ctx.workspace.id, kind, id });
  if (!loaded.ok) {
    const r = REFUSALS[loaded.reason] ?? REFUSALS.unreadable!;
    return NextResponse.json({ error: r.error }, { status: r.status });
  }
  if (!grantCoversHouse(access.grant, loaded.facts.propertyId)) return NextResponse.json({ error: "Record not found." }, { status: 404 });

  const result = await sendOnboardingLink(ctx.db, { workspaceId: ctx.workspace.id, kind, id, actorUserId: ctx.userId }, { facts: async () => loaded });
  if (!result.ok) {
    const r = REFUSALS[result.reason] ?? REFUSALS.send_failed!;
    return NextResponse.json({ error: r.error, reason: result.reason, ...(result.detail ? { detail: String(result.detail).slice(0, 80) } : {}) }, { status: r.status });
  }
  return NextResponse.json({ ok: true });
}
