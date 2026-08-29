"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MODAL_INSET_BOX_CLASS } from "@/components/ui/modal";
import { portalMessageFieldLabel } from "@/components/portal/portal-message-compose-fields";
import { formatManagerMessagingPhone } from "@/lib/sms/manager-messaging-number";
import { cn } from "@/lib/utils";

const MESSAGING_SETTINGS_PATH = "/portal/profile";

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

  if (canSend && phone?.trim()) {
    return (
      <div className={className}>
        <p className={portalMessageFieldLabel()}>Work number (SMS)</p>
        <p className={cn("mt-1 truncate text-sm text-foreground", MODAL_INSET_BOX_CLASS, "py-2")}>
          {formatManagerMessagingPhone(phone)}
        </p>
        <p className="mt-1.5 text-xs text-muted">
          Outbound texts to residents use this PropLane work number.
        </p>
      </div>
    );
  }

  // This hint renders inside the messaging settings page itself as well as in
  // compose surfaces, so pointing at "Settings → Messaging" can send the reader
  // to the page they are already reading. Drop the link there and keep the
  // reason.
  const alreadyOnSettings = pathname?.startsWith(MESSAGING_SETTINGS_PATH) ?? false;
  // A number that exists but cannot send is waiting on carrier approval — there
  // is no setup left for the manager to "finish", and saying otherwise sends
  // them hunting for a control that is not there.
  const awaitingCarrier = Boolean(phone?.trim());

  return (
    <p className={cn("text-xs font-medium text-danger", className)} role="alert">
      {awaitingCarrier
        ? `SMS is waiting on carrier approval for ${formatManagerMessagingPhone(phone!.trim())}.`
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
