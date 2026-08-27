"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { PortalRecordShareModal } from "@/components/portal/portal-record-share-modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { cn } from "@/lib/utils";

type PortalRecordShareKind = "lease" | "application";

type Props = {
  kind: PortalRecordShareKind;
  recordId: string;
  className?: string;
  label?: string;
  dataAttr?: string;
  disabled?: boolean;
  /** Render inside a dropdown menu instead of a standalone button. */
  menuItem?: boolean;
  recordTitle?: string;
  defaultRecipientName?: string;
  defaultEmail?: string;
  defaultPhone?: string;
};

/** Open a share modal with a public view link and optional email/SMS send. */
export function PortalRecordShareLinkButton({
  kind,
  recordId,
  className,
  label = "Share",
  dataAttr,
  disabled = false,
  menuItem = false,
  recordTitle,
  defaultRecipientName,
  defaultEmail,
  defaultPhone,
}: Props) {
  const { showToast } = useAppUi();
  const [open, setOpen] = useState(false);

  const openShare = () => {
    if (disabled || !recordId.trim()) return;
    if (isDemoModeActive()) {
      showToast("Share is not available in the demo tour.");
      return;
    }
    setOpen(true);
  };

  return (
    <>
      {menuItem ? (
        <DropdownMenuItem
          data-attr={dataAttr}
          disabled={disabled}
          onSelect={(e) => {
            e.preventDefault();
            openShare();
          }}
        >
          {label}
        </DropdownMenuItem>
      ) : (
        <Button
          type="button"
          variant="outline"
          className={cn(className)}
          data-attr={dataAttr}
          disabled={disabled}
          onClick={openShare}
        >
          {label}
        </Button>
      )}

      <PortalRecordShareModal
        open={open}
        onClose={() => setOpen(false)}
        kind={kind}
        recordId={recordId}
        recordTitle={recordTitle}
        defaultRecipientName={defaultRecipientName}
        defaultEmail={defaultEmail}
        defaultPhone={defaultPhone}
      />
    </>
  );
}
