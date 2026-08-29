"use client";

import Link from "next/link";
import { MODAL_INSET_BOX_CLASS } from "@/components/ui/modal";
import { portalMessageFieldLabel } from "@/components/portal/portal-message-compose-fields";
import { formatManagerMessagingPhone } from "@/lib/sms/manager-messaging-number";
import { cn } from "@/lib/utils";

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

  return (
    <p className={cn("text-xs font-medium text-danger", className)} role="alert">
      SMS needs an active work number.{" "}
      <Link href="/portal/profile?tab=messaging" className="font-semibold text-primary hover:underline">
        Finish setup in Settings → Messaging
      </Link>
      , or turn off SMS for this send.
    </p>
  );
}
