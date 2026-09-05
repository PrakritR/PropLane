"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Check, Copy } from "lucide-react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { MODAL_INSET_BOX_CLASS } from "@/components/ui/modal";
import { portalMessageFieldLabel } from "@/components/portal/portal-message-compose-fields";
import { copyTextToClipboard } from "@/lib/manager-property-links";
import { formatManagerMessagingPhone } from "@/lib/sms/manager-messaging-number";
import { cn } from "@/lib/utils";

const MESSAGING_SETTINGS_PATH = "/portal/profile";

export function ManagerWorkNumberCopyControl({
  phone,
  className,
  dataAttr = "work-number-copy",
}: {
  phone: string;
  className?: string;
  dataAttr?: string;
}) {
  const { showToast } = useAppUi();
  const [copied, setCopied] = useState(false);
  const trimmed = typeof phone === "string" ? phone.trim() : "";
  const formatted = formatManagerMessagingPhone(trimmed);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copyNumber() {
    if (!trimmed) return;
    const ok = await copyTextToClipboard(trimmed);
    showToast(ok ? "Work number copied." : "Could not copy work number.");
    if (ok) setCopied(true);
  }

  return (
    <div className={className}>
      <p className={portalMessageFieldLabel()}>Work number</p>
      <button
        type="button"
        disabled={!trimmed}
        onClick={() => void copyNumber()}
        data-attr={dataAttr}
        title="Copy work number"
        aria-label={`Copy work number ${formatted}`}
        className={cn(
          "mt-1 flex w-full cursor-pointer items-center gap-2 text-left",
          MODAL_INSET_BOX_CLASS,
          "py-2 text-sm text-foreground transition-colors hover:border-primary/40 hover:bg-accent/60",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{formatted}</span>
        {copied ? (
          <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
        ) : (
          <Copy className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
        )}
      </button>
      <p className="mt-1.5 text-xs text-muted" aria-live="polite">
        {copied ? "Copied to clipboard." : "Click the number to copy. Outbound texts use this PropLane number."}
      </p>
    </div>
  );
}

export function ManagerSmsWorkNumberHint({
  show,
  phone,
  canSend,
  className,
}: {
  show: boolean;
  phone: string | null;
  canSend: boolean;
  className?: string;
}) {
  const pathname = usePathname();

  if (!show) return null;

  const trimmed = typeof phone === "string" ? phone.trim() : "";
  if (canSend && trimmed) {
    return <ManagerWorkNumberCopyControl phone={trimmed} className={className} />;
  }

  // This hint renders inside the messaging settings page itself as well as in
  // compose surfaces, so pointing at "Settings → Messaging" can send the reader
  // to the page they are already reading. Drop the link there and keep the
  // reason.
  const alreadyOnSettings = pathname?.startsWith(MESSAGING_SETTINGS_PATH) ?? false;
  // A number that exists but cannot send is waiting on carrier approval — there
  // is no setup left for the manager to "finish", and saying otherwise sends
  // them hunting for a control that is not there.
  const awaitingCarrier = Boolean(trimmed);

  return (
    <p className={cn("text-xs font-medium text-danger", className)} role="alert">
      {awaitingCarrier
        ? `SMS is waiting on carrier approval for ${formatManagerMessagingPhone(trimmed)}.`
        : "SMS needs an active work number."}{" "}
      {alreadyOnSettings ? null : (
        <>
          <Link
            href="/portal/profile?tab=messaging"
            className="font-semibold text-primary hover:underline"
          >
            {awaitingCarrier ? "Check status in Settings → Messaging" : "Finish setup in Settings → Messaging"}
          </Link>
          ,{" "}
        </>
      )}
      {alreadyOnSettings ? "Turn off SMS for this send in the meantime." : "or turn off SMS for this send."}
    </p>
  );
}
