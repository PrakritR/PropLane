"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { type CheckboxMultiSelectGroup } from "@/components/ui/checkbox-multi-select";
import { PortalMessageComposeRecipientSection } from "@/components/portal/portal-message-compose-fields";
import { useAppUi } from "@/components/providers/app-ui-provider";
import type { ManagerSmsResidentConversation } from "@/lib/manager-sms-messages";
import {
  MANUAL_SMS_NETWORK_UNKNOWN_MESSAGE,
  MANUAL_SMS_UNKNOWN_MESSAGE,
  resolveManualSmsAttempt,
  type ManualSmsAttempt,
} from "@/lib/sms/manual-send-attempt";

type SmsComposeSection = "resident" | "applicant";

function formatPhoneDisplay(phone: string | null): string {
  if (!phone?.trim()) return "—";
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return phone;
}

function personKey(r: ManagerSmsResidentConversation): string {
  return r.residentUserId ?? r.residentEmail ?? r.phone ?? r.name;
}

/** Same middot convention as email compose: Name · Status · House/phone. */
function smsContactOptionLabel(r: ManagerSmsResidentConversation): string {
  const status = r.tenancyStatus === "applicant" ? "Applicant" : "Resident";
  const houseOrPhone = r.propertyLabel?.trim() || formatPhoneDisplay(r.phone);
  return [r.name, status, houseOrPhone].filter(Boolean).join(" · ");
}

function sectionLabel(section: SmsComposeSection): string {
  if (section === "applicant") return "Applicants";
  return "Residents";
}

/** Compose a new SMS — same TO / Which people multi-select pattern as New message. */
export function ManagerSmsComposeModal({
  open,
  onClose,
  residents,
  onSent,
  endpoint = "/api/manager/sms-conversations",
}: {
  open: boolean;
  onClose: () => void;
  residents: ManagerSmsResidentConversation[];
  onSent?: () => void;
  /** Send endpoint. Admin oversight passes its admin-scoped route. */
  endpoint?: string;
}) {
  const { showToast } = useAppUi();
  const withPhone = useMemo(
    () => residents.filter((r) => Boolean(r.phone?.trim())),
    [residents],
  );

  const [selectedSections, setSelectedSections] = useState<SmsComposeSection[]>(
    [],
  );
  const [selectedPeople, setSelectedPeople] = useState<string[]>([]);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sendIssue, setSendIssue] = useState<string | null>(null);
  const attemptRef = useRef<ManualSmsAttempt | null>(null);

  const directorySections = selectedSections;

  const sectionOptions = useMemo(() => {
    const allSections: { value: SmsComposeSection; label: string }[] = [
      { value: "resident", label: "Residents" },
      { value: "applicant", label: "Applicants" },
    ];
    const base = allSections.filter((opt) =>
      withPhone.some((r) =>
        opt.value === "applicant"
          ? r.tenancyStatus === "applicant"
          : r.tenancyStatus !== "applicant",
      ),
    );
    return base;
  }, [withPhone]);

  const personGroups = useMemo((): CheckboxMultiSelectGroup[] => {
    return directorySections
      .map((section) => {
        const options = withPhone
          .filter((r) =>
            section === "applicant"
              ? r.tenancyStatus === "applicant"
              : r.tenancyStatus !== "applicant",
          )
          .sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
          )
          .map((r) => ({
            value: personKey(r),
            label: smsContactOptionLabel(r),
          }));
        return { label: sectionLabel(section), options };
      })
      .filter((g) => g.options.length > 0);
  }, [directorySections, withPhone]);

  const flatPersonOptions = useMemo(
    () => personGroups.flatMap((g) => g.options),
    [personGroups],
  );
  const validPersonKeys = useMemo(
    () => new Set(flatPersonOptions.map((o) => o.value)),
    [flatPersonOptions],
  );

  const selectedRecipients = useMemo(
    () => withPhone.filter((r) => selectedPeople.includes(personKey(r))),
    [selectedPeople, withPhone],
  );

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      setSelectedSections([]);
      setSelectedPeople([]);
      setBody("");
      setSendIssue(null);
      attemptRef.current = null;
    });
  }, [open]);

  useEffect(() => {
    setSelectedPeople((prev) => prev.filter((key) => validPersonKeys.has(key)));
  }, [validPersonKeys]);

  async function send() {
    if (selectedSections.length === 0) {
      showToast("Select Residents and/or Applicants.");
      return;
    }
    if (directorySections.length > 0 && selectedRecipients.length === 0) {
      showToast("Select at least one person with a phone number.");
      return;
    }
    const text = body.trim();
    if (!text) {
      showToast("Enter a message.");
      return;
    }
    setSending(true);
    setSendIssue(null);
    try {
      let ok = 0;
      let queued = 0;
      let lastError = "Could not send SMS.";
      const targets: { phone: string; residentUserId?: string | null }[] = [];
      const seen = new Set<string>();
      for (const recipient of selectedRecipients) {
        if (!recipient.phone || seen.has(recipient.phone)) continue;
        seen.add(recipient.phone);
        targets.push({
          phone: recipient.phone,
          residentUserId: recipient.residentUserId,
        });
      }
      if (targets.length === 0) {
        showToast("Add at least one phone number.");
        return;
      }
      const attemptSignature = JSON.stringify([
        text,
        ...targets.map((recipient) => [
          recipient.phone,
          recipient.residentUserId ?? null,
        ]),
      ]);
      const attempt = resolveManualSmsAttempt(
        attemptRef.current,
        attemptSignature,
        targets.length,
      );
      attemptRef.current = attempt;
      let ambiguousOutcome = false;
      for (const [index, recipient] of targets.entries()) {
        const res = await fetch(endpoint, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": attempt.idempotencyKeys[index]!,
          },
          body: JSON.stringify({
            toPhone: recipient.phone,
            text,
            residentUserId: recipient.residentUserId ?? undefined,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          code?: string;
          error?: string;
          status?: string;
        };
        if (!res.ok) {
          lastError = data.error ?? lastError;
          if (
            data.code === "delivery_outcome_unknown" ||
            data.status === "unknown"
          ) {
            ambiguousOutcome = true;
          }
          continue;
        }
        ok += 1;
        if (data.status !== "submitted") queued += 1;
      }
      if (ambiguousOutcome) {
        setSendIssue(MANUAL_SMS_UNKNOWN_MESSAGE);
        return;
      }
      if (ok === 0) {
        // A definitive pre-submit failure is safe to retry as a new attempt.
        // Unknown/network outcomes intentionally retain the original keys.
        attemptRef.current = null;
        showToast(lastError);
        return;
      }
      showToast(
        queued > 0
          ? queued === 1
            ? "SMS queued."
            : `${queued} SMS messages queued.`
          : ok === 1
            ? "SMS sent."
            : `SMS sent to ${ok} people.`,
      );
      onClose();
      onSent?.();
    } catch {
      setSendIssue(MANUAL_SMS_NETWORK_UNKNOWN_MESSAGE);
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal
      open={open}
      title="New message"
      onClose={onClose}
      footer={
        <ModalFooter>
          <Button
            type="button"
            variant="primary"
            className="rounded-full"
            disabled={sending || !body.trim() || Boolean(sendIssue)}
            aria-busy={sending}
            data-attr="manager-sms-compose-send"
            onClick={() => send()}
          >
            {sending
              ? "Sending…"
              : selectedPeople.length > 1
                ? `Send SMS (${selectedPeople.length})`
                : "Send SMS"}
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-3">
        {withPhone.length === 0 ? (
          <p className="text-sm text-muted">
            No residents or applicants with a phone number yet. Add a verified
            phone to their profile first.
          </p>
        ) : null}
        <PortalMessageComposeRecipientSection
          sectionOptions={sectionOptions}
          selectedCategories={selectedSections}
          onCategoriesChange={(next) =>
            setSelectedSections(
              next.filter(
                (v): v is SmsComposeSection =>
                  v === "resident" || v === "applicant",
              ),
            )
          }
          sectionDataAttr="manager-sms-compose-section"
          personGroups={personGroups}
          selectedKeys={selectedPeople}
          onPeopleChange={setSelectedPeople}
          peopleDisabled={directorySections.length === 0}
          peopleEmptyMenuText={
            selectedSections.length === 0
              ? "Pick a section first"
              : directorySections.length === 0
                ? "Pick Residents or Applicants first"
                : "No people with phones in selected sections"
          }
          peopleDataAttr="manager-sms-compose-person"
        />

        <div>
          <label
            className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted"
            htmlFor="manager-sms-compose-body"
          >
            Message
          </label>
          <Textarea
            id="manager-sms-compose-body"
            className="mt-1 min-h-[120px]"
            rows={5}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Write your text…"
            maxLength={1600}
            data-attr="manager-sms-compose-body"
          />
          <span className="mt-1 block text-xs text-muted">
            {body.trim().length}/1600
          </span>
        </div>
        {sendIssue ? (
          <p className="text-sm leading-relaxed text-danger" role="alert">
            {sendIssue}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
