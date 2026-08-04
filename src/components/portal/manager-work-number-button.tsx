"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { copyTextToClipboard } from "@/lib/manager-property-links";
import { PORTAL_HEADER_ACTION_BTN } from "@/components/portal/portal-metrics";
import { normalizeManagerSmsConversationsPayload } from "@/lib/manager-sms-messages";

function formatPhoneDisplay(phone: string | null): string {
  if (!phone?.trim()) return "—";
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return phone;
}

/** Copy-only work number popup for manager Communication → SMS. */
export function ManagerWorkNumberButton({ className }: { className?: string }) {
  const { showToast } = useAppUi();
  const [workNumber, setWorkNumber] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let active = true;
    void fetch("/api/manager/sms-conversations", { credentials: "include", cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!active || !body) return;
        const payload = normalizeManagerSmsConversationsPayload(body);
        setWorkNumber(payload.workNumber);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const copyWorkNumber = useCallback(async () => {
    const num = workNumber?.trim();
    if (!num) return;
    const ok = await copyTextToClipboard(num);
    showToast(ok ? "Work number copied." : "Could not copy work number.");
  }, [showToast, workNumber]);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className={`${PORTAL_HEADER_ACTION_BTN} ${className ?? ""}`.trim()}
        onClick={() => setOpen(true)}
      >
        View number
      </Button>
      <Modal
        open={open}
        title="Work number"
        onClose={() => setOpen(false)}
        footer={
          <ModalFooter>
            <Button
              type="button"
              variant="primary"
              className="rounded-full"
              disabled={!workNumber}
              onClick={() => copyWorkNumber()}
            >
              Copy number
            </Button>
          </ModalFooter>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-muted">
            {workNumber
              ? "This number is auto-assigned for your manager account and cannot be edited here. Hand it out — texts to it land in your PropLane inbox, your email, and your phone."
              : "No number is assigned to this account yet. A dedicated PropLane texting number is included with an active Pro or Business subscription."}
          </p>
          <p className="rounded-xl border border-border bg-accent/25 px-3 py-2 text-base font-semibold text-foreground">
            {formatPhoneDisplay(workNumber)}
          </p>
        </div>
      </Modal>
    </>
  );
}
