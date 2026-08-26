"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";

const FORM_ID = "manager-sms-contact-form";

export function ManagerSmsContactModal({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (contact: {
    conversationKey: string;
    displayName: string;
    phone: string;
    counterpartyRole: "resident" | "applicant" | "prospect" | "vendor" | "manager" | "admin" | "unknown";
  }) => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDisplayName("");
    setPhone("");
    setError(null);
    setSaving(false);
  }, [open]);

  const submit = async () => {
    const name = displayName.trim();
    const number = phone.trim();
    if (!name || name.length > 80) {
      setError("Enter a contact name up to 80 characters.");
      return;
    }
    if (!number) {
      setError("Enter a phone number.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/manager/sms-contacts", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: name, phone: number }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        contact?: {
          conversationKey?: string;
          displayName?: string;
          phone?: string;
          counterpartyRole?: string;
        };
      };
      const contact = payload.contact;
      const role = contact?.counterpartyRole;
      const allowedRoles = new Set([
        "resident",
        "applicant",
        "prospect",
        "vendor",
        "manager",
        "admin",
        "unknown",
      ]);
      if (
        !response.ok ||
        !contact?.conversationKey ||
        !contact.displayName ||
        !contact.phone ||
        !role ||
        !allowedRoles.has(role)
      ) {
        throw new Error(payload.error ?? "Could not save contact.");
      }
      onSaved({
        conversationKey: contact.conversationKey,
        displayName: contact.displayName,
        phone: contact.phone,
        counterpartyRole: role as
          | "resident"
          | "applicant"
          | "prospect"
          | "vendor"
          | "manager"
          | "admin"
          | "unknown",
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save contact.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add phone contact"
      description="Save a number in Communication before the first message."
      panelClassName="max-w-md"
      assistantStrip={false}
      dataAttr="sms-contact-create-modal"
      footer={
        <ModalFooter>
          <Button
            type="submit"
            form={FORM_ID}
            disabled={saving}
            data-attr="sms-contact-create-save"
          >
            {saving ? "Saving…" : "Save contact"}
          </Button>
        </ModalFooter>
      }
    >
      <form
        id={FORM_ID}
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="block space-y-1.5 text-sm font-medium text-foreground">
          <span>Name</span>
          <Input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            autoComplete="name"
            maxLength={80}
            placeholder="Jordan Lee"
            disabled={saving}
            autoFocus
            data-attr="sms-contact-create-name"
          />
        </label>
        <label className="block space-y-1.5 text-sm font-medium text-foreground">
          <span>Phone number</span>
          <Input
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="+1 206 555 0123"
            disabled={saving}
            aria-describedby="sms-contact-consent-note"
            data-attr="sms-contact-create-phone"
          />
        </label>
        <p id="sms-contact-consent-note" className="text-xs leading-relaxed text-muted">
          Saving a contact does not opt them into texts. PropLane will only send after the person has provided valid SMS consent.
        </p>
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
