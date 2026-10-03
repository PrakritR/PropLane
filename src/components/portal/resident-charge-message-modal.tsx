"use client";

import { PopupMessagePreview, PopupRecordPreview } from "@/components/portal/popup-live-preview";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import type { HouseholdCharge } from "@/lib/household-charges";
import {
  RESIDENT_CHARGE_MESSAGE_MAX_LENGTH,
  RESIDENT_CHARGE_MESSAGE_MIN_LENGTH,
} from "@/lib/resident-charge-message";
import { safeFormatDateTime } from "@/lib/pacific-time";

type ResidentChargeMessageModalProps = {
  open: boolean;
  charge: HouseholdCharge | null;
  onClose: () => void;
  onSent?: (charge: HouseholdCharge) => void;
};

export function ResidentChargeMessageModal({
  open,
  charge,
  onClose,
  onSent,
}: ResidentChargeMessageModalProps) {
  const { showToast } = useAppUi();
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open) {
      setMessage("");
      setSending(false);
    }
  }, [open]);

  const priorMessages = charge?.residentChargeMessages ?? [];
  const trimmed = message.trim();
  const canSend =
    trimmed.length >= RESIDENT_CHARGE_MESSAGE_MIN_LENGTH &&
    trimmed.length <= RESIDENT_CHARGE_MESSAGE_MAX_LENGTH &&
    !sending;

  async function sendMessage() {
    if (!charge || !canSend) return;
    setSending(true);
    try {
      const res = await fetch("/api/portal/household-charge-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ chargeId: charge.id, message: trimmed }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        charge?: HouseholdCharge;
        error?: string;
      };
      if (!res.ok || !data.ok || !data.charge) {
        showToast(data.error ?? "Could not send message.");
        return;
      }
      showToast("Message sent to your property manager.");
      onSent?.(data.charge);
      onClose();
    } catch {
      showToast("Could not send message.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (sending) return;
        onClose();
      }}
      title="Message about this charge"
      contextPanel={<PopupRecordPreview rows={[{ label: "Charge", value: charge?.title }, { label: "Balance", value: charge?.balanceLabel }]} />}
      previewLabel="Message preview"
      preview={<PopupMessagePreview body={message} subject={charge?.title} recipient="Property manager" channel="PropLane" />}
      footer={<ModalFooter><Button type="button" variant="primary" className="rounded-full" disabled={!canSend} data-attr="resident-charge-message-send" onClick={() => sendMessage()}>{sending ? "Sending…" : "Send message"}</Button></ModalFooter>}
      panelClassName="max-w-lg"
    >
      {charge ? (
        <div className="space-y-4 text-sm">


          {priorMessages.length > 0 ? (
            <div className="space-y-2 rounded-xl border border-border bg-accent/20 p-3">
              <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">Previous messages</p>
              <ul className="space-y-2">
                {priorMessages.map((entry) => (
                  <li key={entry.id} className="rounded-lg border border-border bg-card px-3 py-2">
                    <p className="whitespace-pre-wrap leading-relaxed text-foreground">{entry.body}</p>
                    <p className="mt-1 text-xs text-muted">{safeFormatDateTime(entry.sentAt)}</p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div>
            <label htmlFor="resident-charge-message-body" className="text-xs font-semibold text-muted">
              Your message
            </label>
            <textarea
              id="resident-charge-message-body"
              required
              minLength={RESIDENT_CHARGE_MESSAGE_MIN_LENGTH}
              className="mt-1.5 min-h-[8rem] w-full resize-y rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-ring"
              value={message}
              maxLength={RESIDENT_CHARGE_MESSAGE_MAX_LENGTH}
              placeholder="Example: I was charged twice for March rent, or I need more time before this is due…"
              data-attr="resident-charge-message-input"
              onChange={(event) => setMessage(event.target.value)}
            />
            <p className="mt-1 text-xs text-muted">
              {trimmed.length}/{RESIDENT_CHARGE_MESSAGE_MAX_LENGTH} characters
            </p>
          </div>


        </div>
      ) : null}
    </Modal>
  );
}
