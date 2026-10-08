"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { SitePage } from "@/components/marketing/site/site-page";

// Partner inquiries unify into public /contact ("Connect with the PropLane team").
// Preserves ?tab=schedule for "Book a demo" / consultation deep links.
function PartnerContactRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const scheduleTab = searchParams.get("tab") === "schedule";

  useEffect(() => {
    router.replace(scheduleTab ? "/contact?tab=schedule" : "/contact");
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
