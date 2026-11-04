"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

type PermissionStatus = "checking" | "ready" | "granted" | "suppressed" | "unavailable";

function responseError(body: unknown): string {
  if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
    return body.error;
  }
  return "Quote text permission could not be saved.";
}

export function VendorQuotePermission({ workOrderId }: { workOrderId: string }) {
  const [status, setStatus] = useState<PermissionStatus>("checking");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ workOrderId });
    void fetch(`/api/portal/vendor-sourcing-permission?${params}`, {
      credentials: "include",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) {
        setStatus("unavailable");
        return;
      }
      const body = await response.json() as { permissionGranted?: boolean; suppressed?: boolean };
      setStatus(body.suppressed ? "suppressed" : body.permissionGranted ? "granted" : "ready");
    }).catch((cause: unknown) => {
      if (cause instanceof Error && cause.name === "AbortError") return;
      setStatus("unavailable");
    });
    return () => controller.abort();
  }, [workOrderId]);

  const allowQuoteTexts = async () => {
    setError(null);
    try {
      const response = await fetch("/api/portal/vendor-sourcing-permission", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workOrderId, enabled: true }),
      });
      const body = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        setError(responseError(body));
        return;
      }
      setStatus("granted");
    } catch {
      setError("Quote text permission could not be saved.");
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2" data-attr="vendor-quote-permission">
      {status === "ready" ? (
        <Button type="button" variant="outline" onClick={allowQuoteTexts} data-attr="vendor-allow-quote-request-texts">
          Allow quote request texts
        </Button>
      ) : null}
      {status === "checking" ? <span role="status" aria-live="polite" className="text-xs text-muted-foreground">Checking</span> : null}
      {status === "granted" ? <span role="status" aria-live="polite" className="text-xs text-muted-foreground">Quote texts allowed</span> : null}
      {status === "suppressed" ? <span role="status" aria-live="polite" className="text-xs text-muted-foreground">Text messages paused</span> : null}
      {status === "unavailable" ? <span role="status" aria-live="polite" className="text-xs text-muted-foreground">Unavailable</span> : null}
      {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}
