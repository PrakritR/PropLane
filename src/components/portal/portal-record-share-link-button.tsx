"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { cn } from "@/lib/utils";

type PortalRecordShareKind = "lease" | "application";

type Props = {
  kind: PortalRecordShareKind;
  recordId: string;
  className?: string;
  label?: string;
  dataAttr?: string;
  disabled?: boolean;
};

/**
 * Create a public view link and copy it to the clipboard.
 *
 * 90 days is the server's own maximum, chosen deliberately: this is the ceiling the mint route
 * enforces, so the UI now promises exactly what the server will do rather than a shorter figure
 * it never applied. Note what that means — the link is unauthenticated for a full quarter and
 * there is no revoke path yet, so anyone it reaches, or anyone it is forwarded to, can open the
 * record until it expires on its own.
 */
export function PortalRecordShareLinkButton({
  kind,
  recordId,
  className,
  label = "Copy link",
  dataAttr,
  disabled = false,
}: Props) {
  const { showToast } = useAppUi();
  const [busy, setBusy] = useState(false);

  const copyLink = async () => {
    if (busy || disabled || !recordId.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/portal/record-share-link", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, recordId: recordId.trim(), expiresInDays: 90 }),
      });
      const data = (await res.json()) as { link?: { url?: string }; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not create link.");
      const url = data.link?.url?.trim();
      if (!url) throw new Error("No link returned.");
      await navigator.clipboard.writeText(url);
      showToast("View link copied (anyone with the link can open it · expires in 90 days).");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not copy link.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      className={cn(className)}
      data-attr={dataAttr}
      disabled={disabled || busy}
      onClick={() => void copyLink()}
    >
      {busy ? "Copying…" : label}
    </Button>
  );
}
