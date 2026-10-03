import Link from "next/link";

import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export default async function ShortStayConfirmationPage({
  searchParams,
}: {
  searchParams: Promise<{ request?: string; propertyId?: string; bookingId?: string; canceled?: string }>;
}) {
  const params = await searchParams;
  const isRequest = params.request === "1";
  const canceled = params.canceled === "1";
  const propertyId = params.propertyId?.trim() ?? "";
  const bookingId = params.bookingId?.trim() ?? "";

  let holdMessage: string | null = null;
  if (canceled && bookingId) {
    try {
      const db = createSupabaseServiceRoleClient();
      const { data } = await db.from("portal_schedule_records").select("row_data").eq("id", bookingId).maybeSingle();
      const stay = data?.row_data as { stayDetails?: { holdExpiresAt?: string } } | null;
      const expires = stay?.stayDetails?.holdExpiresAt;
      if (expires) {
        const mins = Math.max(1, Math.round((Date.parse(expires) - Date.now()) / 60_000));
        holdMessage = `Your dates stay held for about ${mins} more minute${mins === 1 ? "" : "s"}. Retry payment to confirm.`;
      } else {
        holdMessage = "Your dates stay held for 15 minutes. Retry payment to confirm.";
      }
    } catch {
      holdMessage = "Your dates stay held for 15 minutes. Retry payment to confirm.";
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4 px-4 py-10" data-st9-done>
      <h1 className="text-xl font-bold text-foreground">
        {isRequest ? "Request sent" : canceled ? "Payment not completed" : "You’re booked"}
      </h1>
      <p className="text-sm text-foreground">
        {isRequest
          ? "The manager reviews your request. You pay only if it is approved."
          : canceled
            ? holdMessage
            : "Check your email for the receipt. Door code, Wi‑Fi, and house rules appear in Move-in when your stay is near."}
      </p>
      {!isRequest && !canceled ? (
        <p className="text-sm text-muted">
          Questions? Use the work number and email from your confirmation email.
        </p>
      ) : null}
      {propertyId ? (
        <Link
          href={
            canceled
              ? `/rent/stay?propertyId=${encodeURIComponent(propertyId)}${bookingId ? `&bookingId=${encodeURIComponent(bookingId)}` : ""}`
              : `/rent/listings/${encodeURIComponent(propertyId)}`
          }
          className="text-sm font-semibold text-primary"
        >
          {canceled ? "Try payment again" : "Back to listing"}
        </Link>
      ) : (
        <Link href="/rent/browse" className="text-sm font-semibold text-primary">Back to browse</Link>
      )}
    </div>
  );
}
