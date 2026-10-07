"use client";

import { useEffect, useState } from "react";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { WizardField, WizardLine } from "@/components/portal/add-workspace/parts";
import { MoneyInput, StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { PortalSettingsToggle } from "@/components/portal/portal-settings-ui";
import { Input } from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import { fetchPhoneTextStatus, type PhoneTextStatus } from "@/lib/service-work-share-client";
import { canSendToPhone, publishBudgetCents } from "@/lib/service-work-share-ui";

const SEND_STEPS: AddWorkspaceStep[] = [{ id: "send", label: "Send to phone" }];
const PUBLISH_STEPS: AddWorkspaceStep[] = [{ id: "publish", label: "Publish to vendors" }];

export type SendToPhoneInput = { phone: string; recipientName: string; sharePhotos: boolean; attestWorksWithVendor: boolean };

/**
 * Send to phone: the standard single-step popup (same shell as Send job). Phone, optional name, Share photos,
 * and the "I work with this vendor" attestation the server also requires. The host performs the send and
 * resolves true when it went (the popup then closes); on false it stays open so the manager can fix the number.
 */
export function ServiceSendToPhonePopup({
  open,
  onClose,
  onSend,
}: {
  open: boolean;
  onClose: () => void;
  onSend: (input: SendToPhoneInput) => Promise<boolean | "attest">;
}) {
  // Mounted only while open, so every open starts blank.
  return open ? <SendToPhoneBody onClose={onClose} onSend={onSend} /> : null;
}

function SendToPhoneBody({ onClose, onSend }: { onClose: () => void; onSend: (input: SendToPhoneInput) => Promise<boolean | "attest"> }) {
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [sharePhotos, setSharePhotos] = useState(false);
  const [attest, setAttest] = useState(false);
  const [sending, setSending] = useState(false);
  // The "I work with this vendor" box exists only while the first text to this number still needs it.
  const [status, setStatus] = useState<PhoneTextStatus | null>(null);
  const [forceAttest, setForceAttest] = useState(false);
  const phoneDigits = phone.replace(/\D/g, "");
  const phoneKey = phoneDigits.length >= 10 ? phoneDigits : "";
  useEffect(() => {
    setStatus(null);
    if (!phoneKey) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void fetchPhoneTextStatus(phoneKey).then((next) => {
        if (active) setStatus(next);
      });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [phoneKey]);
  const attestationNeeded = forceAttest || status === null || status.needsAttestation;
  const optedOut = status?.optedOut === true;
  const ready = canSendToPhone({ phone, attestWorksWithVendor: attest, attestationNeeded, optedOut });

  const send = async () => {
    if (!ready || sending) return;
    setSending(true);
    try {
      const sent = await onSend({ phone, recipientName: name.trim(), sharePhotos, attestWorksWithVendor: attestationNeeded && attest });
      if (sent === "attest") setForceAttest(true);
      else if (sent) onClose();
    } finally {
      setSending(false);
    }
  };

  return (
    <AddWorkspace
      title="Send to phone"
      steps={SEND_STEPS}
      current={0}
      onJump={() => {}}
      onClose={onClose}
      dirty={phone.trim() !== "" || name.trim() !== "" || sharePhotos || attest}
      discardTitle="Discard this?"
      discardBody="The service has not been sent. Close and lose your choices?"
      assistantContext="Text a service to a vendor's phone."
      assistantScopeKey="Send to phone"
      lastLabel="Send"
      lastDisabled={!ready}
      busy={sending}
      onFinish={() => void send()}
      dataAttrPrefix="service-send-to-phone"
      finishDataAttr="service-send-to-phone-send"
    >
      <StepColumn>
        <StepHeading title="Send to phone" />
        <WizardField label="Phone" required>
          <PhoneNumberField value={phone} onChange={setPhone} disabled={sending} required dataAttr="service-send-to-phone-phone" />
        </WizardField>
        <WizardField label="Name">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            autoComplete="off"
            disabled={sending}
            data-attr="service-send-to-phone-name"
          />
        </WizardField>
        <WizardLine
          label="Share photos"
          control={<PortalSettingsToggle checked={sharePhotos} onChange={setSharePhotos} label="Share photos" disabled={sending} dataAttr="service-send-to-phone-photos" />}
        />
        {attestationNeeded ? (
          <WizardLine
            label="I work with this vendor"
            control={<PortalSettingsToggle checked={attest} onChange={setAttest} label="I work with this vendor" disabled={sending} dataAttr="service-send-to-phone-attest" />}
          />
        ) : null}
      </StepColumn>
    </AddWorkspace>
  );
}

/**
 * Publish to vendors: Budget ("Up to", optional) and Share photos (default off). The host calls the publish
 * route and mirrors the returned patch locally; the popup closes when it resolves true.
 */
export function ServicePublishPopup({
  open,
  onClose,
  onPublish,
}: {
  open: boolean;
  onClose: () => void;
  onPublish: (input: { budgetCents: number | null; sharePhotos: boolean }) => Promise<boolean>;
}) {
  return open ? <PublishBody onClose={onClose} onPublish={onPublish} /> : null;
}

function PublishBody({ onClose, onPublish }: { onClose: () => void; onPublish: (input: { budgetCents: number | null; sharePhotos: boolean }) => Promise<boolean> }) {
  const [budget, setBudget] = useState("");
  const [sharePhotos, setSharePhotos] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const publish = async () => {
    if (publishing) return;
    setPublishing(true);
    try {
      const done = await onPublish({ budgetCents: publishBudgetCents(budget), sharePhotos });
      if (done) onClose();
    } finally {
      setPublishing(false);
    }
  };

  return (
    <AddWorkspace
      title="Publish to vendors"
      steps={PUBLISH_STEPS}
      current={0}
      onJump={() => {}}
      onClose={onClose}
      dirty={budget.trim() !== "" || sharePhotos}
      discardTitle="Discard this?"
      discardBody="The service has not been published. Close and lose your choices?"
      assistantContext="Publish a service to vendors."
      assistantScopeKey="Publish to vendors"
      lastLabel="Publish"
      busy={publishing}
      onFinish={() => void publish()}
      dataAttrPrefix="service-publish"
      finishDataAttr="service-publish-confirm"
    >
      <StepColumn>
        <StepHeading title="Publish to vendors" />
        <WizardLine
          label="Budget"
          control={<MoneyInput value={budget} onChange={setBudget} label="Up to" placeholder="Up to" dataAttr="service-publish-budget" />}
        />
        <WizardLine
          label="Share photos"
          control={<PortalSettingsToggle checked={sharePhotos} onChange={setSharePhotos} label="Share photos" disabled={publishing} dataAttr="service-publish-photos" />}
        />
      </StepColumn>
    </AddWorkspace>
  );
}
