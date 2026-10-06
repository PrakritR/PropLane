import type { Metadata } from "next";
import { Suspense } from "react";
import SharedFormLinkClient from "./shared-form-link-client";

/** The token is a path segment and the page reads a session, so never prerender or index it. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Open a form",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function SharedFormLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <Suspense fallback={null}>
      <SharedFormLinkClient token={token} />
    </Suspense>
  );
}
