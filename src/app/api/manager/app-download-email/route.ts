import { NextResponse } from "next/server";
import { getPortalAccessContext, hasRole } from "@/lib/auth/portal-access";
import { iosAppDownloadUrl } from "@/lib/ios-app-download";
import { postResendEmail } from "@/lib/resend-delivery.server";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * N068: a desktop viewer of the manager App tab has no fast way to get the
 * PropLane download link onto their phone besides the QR code. This emails
 * the SAME fixed download URL the QR code and App Store badge already point
 * at, to the signed-in manager's OWN account email — never a caller-supplied
 * destination, so this can't become a text/email relay to an arbitrary
 * address. (An earlier version of this sent an SMS to a phone number the
 * caller typed in; that let any signed-in account make the platform's
 * default Twilio number text an arbitrary worldwide number — SMS-pumping /
 * toll-fraud risk, and it broke the "outbound from the work number only"
 * invariant — so it was replaced with this email-to-self version.)
 */
const SEND_LIMIT = 3;
const SEND_WINDOW_MS = 60 * 60 * 1000;

export async function POST() {
  const ctx = await getPortalAccessContext();
  if (!ctx.user) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!hasRole(ctx, "manager")) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  const email = (ctx.user.email ?? ctx.profile?.email ?? "").trim();
  if (!email) {
    return NextResponse.json({ error: "No email on this account." }, { status: 400 });
  }

  const limit = await rateLimit(`app-download-email:${ctx.user.id}`, SEND_LIMIT, SEND_WINDOW_MS);
  if (!limit.ok) {
    return NextResponse.json(
      { error: limit.unavailable ? "Could not send right now. Try again shortly." : "Too many emails sent. Try again later." },
      { status: limit.unavailable ? 503 : 429 },
    );
  }

  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json({ error: "Email delivery isn't configured yet." }, { status: 503 });
  }

  const downloadUrl = iosAppDownloadUrl();
  const from = process.env.RESEND_FROM?.trim() || "PropLane <onboarding@resend.dev>";
  const res = await postResendEmail({
    apiKey,
    actorUserId: ctx.user.id,
    payload: {
      from,
      to: [email],
      subject: "Your PropLane app download link",
      text: `Get PropLane on your phone: ${downloadUrl}`,
      html: `<p>Get PropLane on your phone: <a href="${downloadUrl}">${downloadUrl}</a></p>`,
    },
    effectSummary: "App download link email captured for the test workspace.",
  });
  if (!res.ok) {
    return NextResponse.json({ error: "Could not send the email. Try again shortly." }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
