"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { SitePage } from "@/components/marketing/site/site-page";
import { BOOK_DEMO_HREF } from "@/lib/marketing/public-contact";
import { MANAGED_CONTACT_HREF } from "@/lib/marketing/managed-service";

// Partner inquiries unify into the home page's Contact section ("Connect with the PropLane team"), which owns
// that content now. Straight to the anchor, never through the retired /contact route's redirect.
// Preserves the "Book a demo" / consultation deep link.
function PartnerContactRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const scheduleTab = searchParams.get("tab") === "schedule";

  useEffect(() => {
    router.replace(scheduleTab ? BOOK_DEMO_HREF : MANAGED_CONTACT_HREF);
  }, [router, scheduleTab]);

  return (
    <SitePage>
    <div className="min-h-screen px-4 py-16 sm:py-20">
      <div className="glass-card mx-auto max-w-2xl rounded-3xl p-8">
        <p className="text-center text-sm text-muted">Redirecting to Contact…</p>
      </div>
    </div>
    </SitePage>
  );
}

export default function PartnerContactPage() {
  return (
    <Suspense fallback={null}>
      <PartnerContactRedirect />
    </Suspense>
  );
}
