import { Suspense } from "react";
import { ShortStayBookingClient } from "@/components/marketing/short-stay-booking-client";

export default function ShortStayPage() {
  return (
    <Suspense fallback={<div className="flex min-h-[50vh] items-center justify-center text-sm text-muted">Loading…</div>}>
      <ShortStayBookingClient />
    </Suspense>
  );
}
