"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import { coercePhoneInput, normalizeE164 } from "@/lib/phone-e164";
import { Modal, ModalFooter } from "@/components/ui/modal";

export type PortalContactDetailsValues = {
  name: string;
  phone: string;
  email: string;
};

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The ONE contact editor behind every conversation's pen — text threads and
 * email threads alike. Both used to carry their own partial form (one with a
 * name and an address, the other with only a number), so the same control
 * opened a different editor depending on which thread you were reading.
 *
 * The parent owns the write and reports server failures through `error`; this
 * component only validates the shapes it can judge on its own.
 */
export function PortalContactDetailsModal({
  open,
  onClose,
  initial,
  onSave,
  saving,
  error,
  formId,
}: {
  open: boolean;
  onClose: () => void;
  /** Re-seeded every time the modal opens, so a cancelled edit never persists. */
  initial: PortalContactDetailsValues;
  onSave: (values: PortalContactDetailsValues) => void;
  saving: boolean;
  error: string | null;
  /** Unique per mount — the footer's submit button targets this form by id. */
  formId: string;
}) {
  const [name, setName] = useState(initial.name);
  const [phone, setPhone] = useState(initial.phone);
  const [email, setEmail] = useState(initial.email);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(initial.name);
    setPhone(coercePhoneInput(initial.phone));
    setEmail(initial.email);
    setLocalError(null);
    // Seeding is intentionally keyed on the open transition: re-seeding on every
    // `initial` identity change would wipe what the manager is typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = () => {
    const nextName = name.trim();
    const nextPhone = normalizeE164(phone);
    const nextEmail = email.trim().toLowerCase();
    if (nextName.length > 80) {
      setLocalError("Enter a contact name up to 80 characters.");
      return;
    }
    if (!nextPhone) {
      setLocalError("Enter a phone number, including country code.");
      return;
    }
    if (nextEmail && !EMAIL_SHAPE.test(nextEmail)) {
      setLocalError("Enter a valid email address.");
      return;
    }
    setLocalError(null);
    onSave({ name: nextName, phone: nextPhone, email: nextEmail });
  };

  const shownError = localError ?? error;

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!saving) onClose();
      }}
      title="Contact details"
      dense
      panelClassName="max-w-md"
      footer={
        <ModalFooter>
          <Button
            type="submit"
            form={formId}
            disabled={saving}
            aria-busy={saving}
            data-attr="contact-details-save"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </ModalFooter>
      }
    >
      <form
        id={formId}
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label htmlFor={`${formId}-name`} className="text-sm font-medium text-foreground">
          Contact name
        </label>
        <Input
          id={`${formId}-name`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={80}
          autoComplete="off"
          spellCheck={false}
          placeholder="e.g. Jordan from Unit 4"
          data-attr="contact-details-name"
        />

        <label
          htmlFor={`${formId}-phone`}
          className="block pt-1 text-sm font-medium text-foreground"
        >
          Phone number
        </label>
        <PhoneNumberField
          id={`${formId}-phone`}
          value={phone}
          onChange={setPhone}
          autoComplete="off"
          dataAttr="contact-details-phone"
        />

        <label
          htmlFor={`${formId}-email`}
          className="block pt-1 text-sm font-medium text-foreground"
        >
          Email address
        </label>
        <Input
          id={`${formId}-email`}
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          maxLength={254}
          autoComplete="off"
          spellCheck={false}
          placeholder="name@example.com"
          data-attr="contact-details-email"
        />

        {shownError ? (
          <p className="text-xs text-danger" role="alert">
            {shownError}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
