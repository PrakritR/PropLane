"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import { Modal, ModalFooter } from "@/components/ui/modal";
import {
  PortalNotificationPreviewModal,
  type NotificationDeliveryChannels,
} from "@/components/portal/portal-notification-preview-modal";
import {
  portalMessageChannelsFromSelection,
  PortalMessageSendViaDropdown,
  PORTAL_MESSAGE_COMPOSE_TWO_COL_CLASS,
} from "@/components/portal/portal-message-compose-fields";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { copyTextToClipboard } from "@/lib/manager-property-links";
import { normalizeManagerSmsConversationsPayload } from "@/lib/manager-sms-messages";
import {
  recordShareEmailBody,
  recordShareSmsText,
  recordShareSubject,
  type RecordShareKind,
} from "@/lib/record-share-message";

const FIELD_LABEL_CLASS = "mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted";

type Props = {
  open: boolean;
  onClose: () => void;
  kind: RecordShareKind;
  recordId: string;
  recordTitle?: string;
};

export function PortalRecordShareModal({
  open,
  onClose,
  kind,
  recordId,
  recordTitle,
}: Props) {
  const { showToast } = useAppUi();
  const wasOpenRef = useRef(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [sendVia, setSendVia] = useState<string[]>(["email"]);
  const [smsAvailable, setSmsAvailable] = useState(false);
  const [note, setNote] = useState("");
  const [sendPreviewOpen, setSendPreviewOpen] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);

  const titleLabel = recordTitle?.trim() || (kind === "lease" ? "Lease" : "Application");
  const docLabel = kind === "lease" ? "lease document" : "application";

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    setRecipientName("");
    setRecipientEmail("");
    setRecipientPhone("");
    setSendVia(["email"]);
    setNote("");
    setSendPreviewOpen(false);
    setSendBusy(false);
    setLinkUrl("");
    setLinkError("");
  }, [open]);

  useEffect(() => {
    if (!open || !recordId.trim() || isDemoModeActive()) return;
    let active = true;
    setLinkBusy(true);
    setLinkError("");
    void fetch("/api/portal/record-share-link", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      // 90 days is the server's own maximum, so the modal promises exactly what the mint route
      // will do rather than a shorter figure it never applied. The link is unauthenticated for
      // that whole quarter and there is no revoke path yet.
      body: JSON.stringify({ kind, recordId: recordId.trim(), expiresInDays: 90 }),
    })
      .then(async (res) => {
        const data = (await res.json()) as { link?: { url?: string }; error?: string };
        if (!active) return;
        if (!res.ok) throw new Error(data.error ?? "Could not create link.");
        setLinkUrl(data.link?.url?.trim() ?? "");
      })
      .catch((e: unknown) => {
        if (!active) return;
        setLinkError(e instanceof Error ? e.message : "Could not create link.");
      })
      .finally(() => {
        if (active) setLinkBusy(false);
      });
    return () => {
      active = false;
    };
  }, [open, kind, recordId]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void fetch("/api/manager/sms-conversations", { credentials: "include", cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!active || !body) return;
        const payload = normalizeManagerSmsConversationsPayload(body);
        setSmsAvailable(Boolean(payload.workNumber?.trim()));
      })
      .catch(() => {
        if (active) setSmsAvailable(false);
      });
    return () => {
      active = false;
    };
  }, [open]);

  const { viaEmail, viaSms } = portalMessageChannelsFromSelection(sendVia);

  const previewBody = useMemo(() => {
    if (!linkUrl) return "";
    const params = {
      kind,
      recordTitle: titleLabel,
      linkUrl,
      recipientName: recipientName.trim() || undefined,
      managerNote: note.trim() || undefined,
    };
    if (viaSms && !viaEmail) return recordShareSmsText(params);
    return recordShareEmailBody(params);
  }, [kind, linkUrl, note, recipientName, titleLabel, viaEmail, viaSms]);

  const handleCopy = async () => {
    if (!linkUrl) return;
    const ok = await copyTextToClipboard(linkUrl);
    showToast(ok ? "Link copied." : "Could not copy link.");
  };

  const sendShare = async (channels?: NotificationDeliveryChannels) => {
    const deliverEmail = channels?.viaEmail ?? viaEmail;
    const deliverSms = channels?.viaSms ?? viaSms;
    if (sendBusy || !recordId.trim()) return;
    if (!deliverEmail && !deliverSms) {
      showToast("Choose email and/or SMS.");
      return;
    }
    if (deliverEmail && !recipientEmail.trim()) {
      showToast("Enter an email address.");
      return;
    }
    if (deliverSms && !recipientPhone.trim()) {
      showToast("Enter a phone number for SMS.");
      return;
    }
    setSendBusy(true);
    try {
      const res = await fetch("/api/portal/record-share-link/send", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          recordId: recordId.trim(),
          viaEmail: deliverEmail,
          viaSms: deliverSms,
          to: recipientEmail.trim(),
          phone: recipientPhone.trim(),
          recipientName: recipientName.trim() || undefined,
          note: note.trim() || undefined,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        linkUrl?: string;
        emailSent?: boolean;
      };
      if (!res.ok) {
        if (data.emailSent) {
          setSendVia(["sms"]);
          setSendPreviewOpen(false);
          showToast(`Email sent. ${data.error ?? "Could not send the text."}`);
          return;
        }
        throw new Error(data.error ?? "Could not send.");
      }
      if (data.linkUrl) setLinkUrl(data.linkUrl);
      showToast(deliverEmail && deliverSms ? "Link sent via email and text." : deliverSms ? "Link sent via text." : "Link sent via email.");
      setSendPreviewOpen(false);
      onClose();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not send.");
    } finally {
      setSendBusy(false);
    }
  };

  return (
    <>
      <Modal
        key={`${kind}-${recordId}`}
        open={open}
        onClose={onClose}
        title={`Share ${docLabel}`}
        description={`Anyone with the link can view this ${docLabel} without signing in. Links expire in 90 days.`}
        panelClassName="max-w-lg"
        dense
        footer={
          <ModalFooter>
            <Button
              type="button"
              data-attr="record-share-send"
              disabled={sendBusy || linkBusy || !linkUrl}
              onClick={() => setSendPreviewOpen(true)}
            >
              Send
            </Button>
          </ModalFooter>
        }
      >
        <div className="space-y-5">
          <div>
            <p className={FIELD_LABEL_CLASS}>View link</p>
            <div className="flex items-stretch gap-2">
              <div className="flex min-h-10 min-w-0 flex-1 items-center rounded-xl border border-border bg-accent/30 px-3 py-2 text-xs text-muted">
                <span className="truncate">
                  {linkBusy ? "Creating link…" : linkError || linkUrl || "Link unavailable."}
                </span>
              </div>
              <Button
                type="button"
                variant="outline"
                className="h-10 shrink-0 rounded-full px-3 text-xs whitespace-nowrap sm:px-4 sm:text-sm"
                disabled={!linkUrl || linkBusy}
                data-attr="record-share-copy-link"
                onClick={() => void handleCopy()}
              >
                Copy
              </Button>
            </div>
          </div>

          <div className="border-t border-border pt-4">
            <p className="text-sm font-semibold text-foreground">Send link</p>
            <p className="mt-1 text-xs text-muted">Email and/or text the link to someone who needs to view it.</p>
            <div className="mt-3 space-y-3">
              <PortalMessageSendViaDropdown
                selected={sendVia}
                onChange={setSendVia}
                smsAvailable={smsAvailable}
                footerNote={
                  smsAvailable
                    ? "SMS uses your PropLane work number."
                    : "Add a work number under Communication → SMS to text recipients."
                }
                dataAttr="record-share-send-via"
              />
              <div className={PORTAL_MESSAGE_COMPOSE_TWO_COL_CLASS}>
                <div>
                  <label htmlFor="record-share-name" className={FIELD_LABEL_CLASS}>
                    Name (optional)
                  </label>
                  <Input
                    id="record-share-name"
                    name="record-share-recipient-name"
                    autoComplete="off"
                    value={recipientName}
                    onChange={(e) => setRecipientName(e.target.value)}
                    placeholder="Recipient name"
                  />
                </div>
                {viaEmail ? (
                  <div>
                    <label htmlFor="record-share-email" className={FIELD_LABEL_CLASS}>
                      Email
                    </label>
                    <Input
                      id="record-share-email"
                      name="record-share-recipient-email"
                      autoComplete="off"
                      type="email"
                      value={recipientEmail}
                      onChange={(e) => setRecipientEmail(e.target.value)}
                      placeholder="recipient@example.com"
                    />
                  </div>
                ) : viaSms ? (
                  <div>
                    <label htmlFor="record-share-phone" className={FIELD_LABEL_CLASS}>
                      Phone
                    </label>
                    <PhoneNumberField
                      id="record-share-phone"
                      name="record-share-recipient-phone"
                      autoComplete="off"
                      value={recipientPhone}
                      onChange={setRecipientPhone}
                      dataAttr="record-share-phone"
                    />
                  </div>
                ) : null}
              </div>
              {viaEmail && viaSms ? (
                <div>
                  <label htmlFor="record-share-phone-sms" className={FIELD_LABEL_CLASS}>
                    Phone (SMS)
                  </label>
                  <PhoneNumberField
                    id="record-share-phone-sms"
                    name="record-share-recipient-phone-sms"
                    autoComplete="off"
                    value={recipientPhone}
                    onChange={setRecipientPhone}
                    dataAttr="record-share-phone-sms"
                  />
                </div>
              ) : null}
              <div>
                <label htmlFor="record-share-note" className={FIELD_LABEL_CLASS}>
                  Note (optional)
                </label>
                <textarea
                  id="record-share-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                  className="w-full rounded-2xl border border-border bg-card px-3.5 py-2 text-sm text-foreground outline-none transition focus:ring-2 focus:ring-primary/25"
                  placeholder="Add context for the recipient…"
                />
              </div>
            </div>
          </div>
        </div>
      </Modal>

      <PortalNotificationPreviewModal
        open={sendPreviewOpen}
        title={`Send ${docLabel}`}
        onClose={() => setSendPreviewOpen(false)}
        recipient={recipientEmail.trim() || "recipient"}
        recipientPhone={recipientPhone.trim() || undefined}
        subject={recordShareSubject(kind, titleLabel)}
        body={previewBody}
        intro="Review the message before sending."
        showSkipMessage={false}
        showChannelPicker
        showSchedule={false}
        emailAvailable
        smsAvailable={smsAvailable}
        defaultViaEmail={viaEmail}
        defaultViaSms={viaSms}
        editableSubject={viaEmail}
        footerNote="Sent via PropLane when email and SMS delivery are configured."
        confirmLabel="Send link"
        confirmBusy={sendBusy}
        confirmBusyLabel="Sending…"
        onConfirm={(_skip, channels) => {
          // The dialog omits `channels` when it has no channel UI to report; fall back to what
          // this modal already resolved rather than sending with both switched off.
          void sendShare(channels ?? { viaEmail, viaSms });
        }}
        panelClassName="max-w-lg"
      />
    </>
  );
}
