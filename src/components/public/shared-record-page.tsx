"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { isSafeLeasePdfDataUrl } from "@/lib/portal-record-share-pdf";

type SharedRecordPayload = {
  title: string;
  subtitle: string;
  expiresAt: string;
  kind: "lease" | "application";
  contentType?: "html" | "pdf";
  html?: string;
  pdfDataUrl?: string;
};

function SharedRecordView({ apiPath }: { apiPath: string }) {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? "";
  const [payload, setPayload] = useState<SharedRecordPayload | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void fetch(apiPath.replace("{token}", encodeURIComponent(token)))
      .then(async (res) => {
        const data = (await res.json()) as SharedRecordPayload & { error?: string };
        if (!res.ok) throw new Error(data.error ?? "Link expired or invalid.");
        if (!cancelled) setPayload(data);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load.");
      });
    return () => {
      cancelled = true;
    };
  }, [apiPath, token]);

  if (error) {
    return (
      <main className="mx-auto flex min-h-[50vh] max-w-lg flex-col justify-center px-6 py-16 text-center">
        <h1 className="text-xl font-semibold text-slate-900">Link unavailable</h1>
        <p className="mt-2 text-sm text-slate-600">{error}</p>
      </main>
    );
  }

  if (!payload) {
    return (
      <main className="mx-auto flex min-h-[50vh] max-w-lg flex-col justify-center px-6 py-16 text-center">
        <p className="text-sm text-slate-600">Loading…</p>
      </main>
    );
  }

  const expires = new Date(payload.expiresAt).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-semibold text-slate-900">{payload.title}</h1>
      <p className="mt-1 text-sm text-slate-600">
        {payload.subtitle} · Shared via PropLane · expires {expires}
      </p>
      <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        {payload.contentType === "pdf" && isSafeLeasePdfDataUrl(payload.pdfDataUrl) ? (
          <iframe
            title={payload.title}
            src={payload.pdfDataUrl}
            className="h-[80vh] w-full"
            sandbox=""
          />
        ) : payload.html ? (
          <iframe title={payload.title} srcDoc={payload.html} className="h-[80vh] w-full" sandbox="" />
        ) : (
          <p className="p-8 text-center text-sm text-slate-600">No document content available.</p>
        )}
      </div>
    </main>
  );
}

export function SharedLeasePage() {
  return <SharedRecordView apiPath="/api/share/leases/{token}" />;
}

export function SharedApplicationPage() {
  return <SharedRecordView apiPath="/api/share/applications/{token}" />;
}
