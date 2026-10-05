import type { Metadata } from "next";
import { Suspense } from "react";
import LinkedFormFillClient from "./linked-form-fill-client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Fill out a form",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function LinkedFormFillPage({ params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  return (
    <Suspense fallback={null}>
      <LinkedFormFillClient requestId={requestId} />
    </Suspense>
  );
}
