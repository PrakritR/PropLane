import { Suspense } from "react";
import { RentBrowsePageClient } from "@/components/marketing/rent-browse-page-client";

export default function RentBrowsePage() {
  return (
    <Suspense fallback={<div className="flex min-h-[50vh] items-center justify-center text-sm text-muted">Loading…</div>}>
      <RentBrowsePageClient />
    </Suspense>
  );
}
