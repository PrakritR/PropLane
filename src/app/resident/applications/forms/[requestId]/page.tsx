import { Suspense } from "react";
import LinkedFormFillClient from "@/app/(public)/f/open/[requestId]/linked-form-fill-client";

export const metadata = { title: "Application form", robots: { index: false, follow: false } };

export default async function ResidentLinkedFormPage({ params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  return <Suspense fallback={<p role="status">Opening form…</p>}><LinkedFormFillClient requestId={requestId} /></Suspense>;
}
