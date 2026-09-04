"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { type CheckboxMultiSelectGroup } from "@/components/ui/checkbox-multi-select";
import {
  defaultPortalMessageChannelSelection,
  defaultPortalMessageScheduleAt,
  PORTAL_MESSAGE_COMPOSE_MODAL_PANEL_CLASS,
  PORTAL_MESSAGE_COMPOSE_TWO_COL_CLASS,
  PortalMessageBodyField,
  PortalMessageComposeModalBody,
  PortalMessageComposeRecipientSection,
  PortalMessageScheduleFields,
  PortalMessageSendViaDropdown,
  PortalMessageSubjectField,
  portalMessageChannelsFromSelection,
  portalMessageFieldLabel,
  portalMessageSendViaFooterNote,
} from "@/components/portal/portal-message-compose-fields";
import { useManagerCommunicationDeliverVia } from "@/hooks/use-manager-communication-deliver-via";
import { portalMessageSelectionFromDeliverVia } from "@/lib/manager-communication-deliver-via";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { mergeInboxScopedContacts } from "@/lib/manager-inbox-contacts";
import {
  composeDirectoryCategories,
  composeValidPersonKeys,
  houseComposeCategoryLabel,
  houseIdFromComposeCategory,
  isAdminOnlyDirectorySelection,
  isHouseComposeCategory,
  mergeAdminComposePersonKey,
  type InboxComposeDirectoryCategory,
} from "@/lib/inbox-compose-recipients";
import {
  broadcastStubForCategory,
  categoryForContactRole,
  contactsForPortal,
  PRIMARY_AXIS_ADMIN_LABEL,
  type InboxScopedContact,
} from "@/data/inbox-scoped-directory";
import type { ManagerSmsResidentConversation } from "@/lib/manager-sms-messages";
import { parseOtherRecipientTokens, normalizePhoneE164, type OtherRecipientToken } from "@/lib/communication-other-recipients";
import type { ManagerComposePrefill } from "@/lib/manager-compose-prefill";
import { buildOptimisticSentThread } from "@/lib/inbox-message-timeline";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";
import { RecipientChipsInput } from "@/components/ui/recipient-chips-input";
import { appendPortalMessageToAdminInbox } from "@/lib/demo-admin-partner-inbox";
import {
  invalidatePersistedInboxCache,
  MANAGER_INBOX_STORAGE_KEY,
  syncPersistedInboxFromServer,
} from "@/lib/portal-inbox-storage";
import {
  isManualSmsOutcomeUnknown,
  MANUAL_SMS_UNKNOWN_MESSAGE,
  resolveManualSmsAttempt,
  type ManualSmsAttempt,
} from "@/lib/sms/manual-send-attempt";

export type CommunicationComposeChannel = "email" | "sms";

type ComposeCategory = InboxComposeDirectoryCategory | "other";
type DirectoryComposeCategory = InboxComposeDirectoryCategory;
type PersonKey =
  | "admin"
  | "broadcast:management"
  | "broadcast:resident"
  | `house:${string}`
  | `id:${string}`;

async function postScheduledInboxMessage(payload: Record<string, unknown>): Promise<boolean> {
  const res = await fetch("/api/portal/scheduled-inbox-messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ ...payload, senderPortal: "manager" }),
  });
  return res.ok;
}

export function buildSmsSchedulePayloads(args: {
  targets: { phone: string; residentUserId?: string | null }[];
  subject: string;
  body: string;
  sendAt: string;
}): Record<string, unknown>[] {
  return args.targets.map((target) => ({
    subject: args.subject || "Message",
    body: args.body,
    sendAt: args.sendAt,
    recipientEmail: `sms:${target.phone}`,
    recipientName: target.phone,
    residentUserId: target.residentUserId ?? undefined,
    deliverViaEmail: false,
    deliverViaSms: true,
  }));
}

/**
 * A person's row in the To picker: their NAME, and the house they are at.
 *
 * Never their email or phone number (PRP-150). The status word is gone too —
 * the section heading above them already says whether they are a potential,
 * current or past resident, so repeating it on every row was noise. The email
 * fallback is what produced a list of addresses instead of people whenever a
 * contact had no property attached.
 */
function contactOptionLabel(contact: InboxScopedContact): string {
  const property = contact.propertyLabel?.trim();
  const name = contact.name?.trim();
  // A contact with no name at all is the one case an address is better than a
  // blank row — it is at least identifiable.
  if (!name) return contact.email;
  return [name, property].filter(Boolean).join(" · ");
}

function categoryLabel(category: ComposeCategory, contacts: InboxScopedContact[]): string {
  if (isHouseComposeCategory(category)) {
    return houseComposeCategoryLabel(category, contacts);
  }
  if (category === "unassigned_residents") return "Residents (no house)";
  if (category === "management") return "Manager";
  if (category === "vendor") return "Vendor";
  if (category === "other") return "Other";
  return "PropLane admin";
}

/**
 * "Everyone at <house>" rows, one per house that actually has residents.
 *
 * The key carries the property id, so the send path resolves the members at SEND
 * time rather than freezing whoever happened to live there when the picker was
 * opened — a resident who moves in between opening the modal and hitting send
 * should still be included.
 *
 * Houses are ordered by name so the list is stable, and a house is only listed
 * when at least two people live there: a one-person "everyone at" row is just
 * that person with a longer label.
 */
export function houseBroadcastOptions(
  residents: InboxScopedContact[],
): { key: `house:${string}`; label: string }[] {
  const byHouse = new Map<string, { label: string; count: number }>();
  for (const contact of residents) {
    const id = contact.propertyId?.trim();
    const label = contact.propertyLabel?.trim();
    if (!id || !label) continue;
    const entry = byHouse.get(id) ?? { label, count: 0 };
    entry.count += 1;
    byHouse.set(id, entry);
  }
  return [...byHouse.entries()]
    .filter(([, entry]) => entry.count > 1)
    .sort((a, b) => a[1].label.localeCompare(b[1].label, undefined, { sensitivity: "base" }))
    .map(([id, entry]) => ({
      key: `house:${id}` as const,
      label: `Everyone at ${entry.label} (${entry.count})`,
    }));
}

function peopleForCategory(
  category: DirectoryComposeCategory,
  contacts: InboxScopedContact[],
): { key: PersonKey; label: string }[] {
  if (category === "admin") {
    return [{ key: "admin", label: PRIMARY_AXIS_ADMIN_LABEL }];
  }
  if (category === "vendor") {
    return contacts
      .filter((c) => c.role === "vendor")
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
      .map((c) => ({ key: `id:${c.id}` as const, label: contactOptionLabel(c) }));
  }
  if (isHouseComposeCategory(category)) {
    const propertyId = houseIdFromComposeCategory(category);
    const atHouse = contacts.filter(
      (c) => c.role === "resident" && c.propertyId?.trim() === propertyId,
    );
    const currentResidents = atHouse.filter(
      (c) => (c.tenancyStatus ?? "resident") === "resident",
    );
    const people = atHouse
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
      .map((c) => ({
        key: `id:${c.id}` as const,
        label: contactOptionLabel(c),
      }));
    return [...houseBroadcastOptions(currentResidents), ...people];
  }
  if (category === "unassigned_residents") {
    return contacts
      .filter(
        (c) =>
          c.role === "resident" &&
          !(c.propertyId?.trim() && c.propertyLabel?.trim()),
      )
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
      .map((c) => ({ key: `id:${c.id}` as const, label: contactOptionLabel(c) }));
  }
  const people = contacts
    .filter((c) => categoryForContactRole("manager", c.role) === "management")
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    .map((c) => ({ key: `id:${c.id}` as const, label: contactOptionLabel(c) }));
  if (category === "management") {
    return [{ key: "broadcast:management", label: "All management" }, ...people];
  }
  return people;
}

/**
 * Shared New message for Communication Email + SMS.
 * Same To / Which people / Other fields; choose Email and/or SMS at the bottom.
 */

/**
 * A default parameter of `[]` builds a NEW array on every render, so any memo
 * or effect keyed on it re-runs forever — that is exactly how this modal hit
 * "Maximum update depth exceeded" when opened from a caller that omits the
 * prop. One frozen module-level empty keeps the identity stable instead.
 */
const NO_LIVE_CONTACTS: InboxScopedContact[] = [];
const NO_SMS_RECIPIENTS: ManagerSmsResidentConversation[] = [];

export function ManagerCommunicationComposeModal({
  open,
  onClose,
  initialChannel = "email",
  liveContacts = NO_LIVE_CONTACTS,
  smsRecipients = NO_SMS_RECIPIENTS,
  smsUiEnabled = false,
  senderName = "Property manager",
  senderEmail = "manager@example.com",
  onSent,
  onStageOptimistic,
  onClearOptimistic,
  initialDraft = null,
}: {
  open: boolean;
  onClose: () => void;
  initialChannel?: CommunicationComposeChannel;
  liveContacts?: InboxScopedContact[];
  smsRecipients?: ManagerSmsResidentConversation[];
  /** When false, the "via SMS" channel is hidden — email-only compose. */
  smsUiEnabled?: boolean;
  senderName?: string;
  senderEmail?: string;
  /** Pre-filled subject/body/recipient when opened from another portal flow. */
  initialDraft?: ManagerComposePrefill | null;
  onSent?: (result: {
    email: boolean;
    sms: boolean;
    primaryRecipientEmail?: string;
  }) => void;
  /** Show the outbound bubble immediately while the send request is in flight. */
  onStageOptimistic?: (thread: PersistedInboxThread) => void;
  onClearOptimistic?: (threadId: string) => void;
}) {
  const { showToast } = useAppUi();
  const [directoryContacts, setDirectoryContacts] = useState<InboxScopedContact[]>([]);
  const localContacts = useMemo(() => contactsForPortal("manager", liveContacts), [liveContacts]);
  const contacts = directoryContacts.length > 0 ? directoryContacts : localContacts;
  /** Other sits last, under Vendor. */
  const categoryOptions = useMemo((): ComposeCategory[] => {
    return [...composeDirectoryCategories("manager", contacts), "other"];
  }, [contacts]);

  const [selectedCategories, setSelectedCategories] = useState<ComposeCategory[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<PersonKey[]>([]);
  const [otherTokens, setOtherTokens] = useState<OtherRecipientToken[]>([]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sendVia, setSendVia] = useState<string[]>(["email"]);
  const [scheduleLater, setScheduleLater] = useState(false);
  const [sendAt, setSendAt] = useState(defaultPortalMessageScheduleAt);
  const [sending, setSending] = useState(false);
  const smsAttemptRef = useRef<ManualSmsAttempt | null>(null);
  const { channelsFor } = useManagerCommunicationDeliverVia();

  const { viaEmail, viaSms } = portalMessageChannelsFromSelection(sendVia);

  const withPhone = useMemo(
    () => smsRecipients.filter((r) => Boolean(r.phone?.trim())),
    [smsRecipients],
  );

  const otherSelected = selectedCategories.includes("other");
  const directoryCategories = useMemo(
    () => selectedCategories.filter((c): c is DirectoryComposeCategory => c !== "other"),
    [selectedCategories],
  );

  const sectionOptions = useMemo(
    () => categoryOptions.map((c) => ({ value: c, label: categoryLabel(c, contacts) })),
    [categoryOptions, contacts],
  );

  const personGroups = useMemo((): CheckboxMultiSelectGroup[] => {
    return directoryCategories
      .map((category) => ({
        label: categoryLabel(category, contacts),
        options: peopleForCategory(category, contacts).map((p) => ({
          value: p.key,
          label: p.label,
        })),
      }))
      .filter((g) => g.options.length > 0);
  }, [directoryCategories, contacts]);

  const flatPersonOptions = useMemo(() => personGroups.flatMap((g) => g.options), [personGroups]);
  const validPersonKeys = useMemo(
    () => composeValidPersonKeys(flatPersonOptions.map((o) => o.value), directoryCategories),
    [directoryCategories, flatPersonOptions],
  );
  const adminOnlyDirectory = isAdminOnlyDirectorySelection(directoryCategories);

  useEffect(() => {
    if (!open) return;
    if (isDemoModeActive()) {
      setDirectoryContacts(localContacts);
      return;
    }
    let active = true;
    setDirectoryContacts(localContacts);
    void fetch("/api/portal/inbox-eligible-contacts?portal=manager", {
      credentials: "include",
      cache: "no-store",
    })
      .then((res) => (res.ok ? res.json() : { contacts: [] }))
      .then((data: { contacts?: InboxScopedContact[] }) => {
        if (!active) return;
        const fromApi = Array.isArray(data.contacts) ? data.contacts : [];
        const vendors = localContacts.filter((c) => c.role === "vendor");
        setDirectoryContacts(mergeInboxScopedContacts(fromApi, vendors, localContacts));
      })
      .catch(() => {
        if (active) setDirectoryContacts(localContacts);
      });
    return () => {
      active = false;
    };
  }, [open, localContacts]);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      const email = initialDraft?.recipientEmail?.trim().toLowerCase();
      if (initialDraft) {
        setSubject(initialDraft.subject);
        setBody(initialDraft.body);
        if (email) {
          setSelectedCategories(["other"]);
          setSelectedKeys([]);
          setOtherTokens([{ kind: "email", value: email, label: email }]);
        } else {
          setSelectedCategories([]);
          setSelectedKeys([]);
          setOtherTokens([]);
        }
      } else {
        setSelectedCategories([]);
        setSelectedKeys([]);
        setOtherTokens([]);
        setSubject("");
        setBody("");
      }
      setSendVia(
        initialDraft?.recipientEmail && initialChannel === "sms"
          ? defaultPortalMessageChannelSelection(true, smsUiEnabled, false, true)
          : portalMessageSelectionFromDeliverVia(
              channelsFor("inbox_default"),
              smsUiEnabled,
            ),
      );
      setScheduleLater(false);
      setSendAt(defaultPortalMessageScheduleAt());
      setSending(false);
      smsAttemptRef.current = null;
    });
  }, [open, initialChannel, smsUiEnabled, initialDraft, channelsFor]);

  // Each of these prunes a selection when its source list changes. They MUST
  // return the previous array when nothing was removed: `filter` always builds
  // a new array, and returning one unconditionally re-renders, which re-runs
  // the effect if its dependency is not identity-stable — an infinite loop.
  // Handing back `prev` lets React bail out on `Object.is`.
  useEffect(() => {
    setSelectedCategories((prev) => {
      const next = prev.filter((c) => categoryOptions.includes(c));
      return next.length === prev.length ? prev : next;
    });
  }, [categoryOptions]);

  useEffect(() => {
    setSelectedKeys((prev) => {
      const next = mergeAdminComposePersonKey(directoryCategories, prev);
      return next.length === prev.length && next.every((k, i) => k === prev[i]) ? prev : next;
    });
  }, [directoryCategories]);

  useEffect(() => {
    setSelectedKeys((prev) => {
      const next = prev.filter((key) => validPersonKeys.has(key));
      return next.length === prev.length ? prev : next;
    });
  }, [validPersonKeys]);

  useEffect(() => {
    if (!otherSelected) setOtherTokens([]);
  }, [otherSelected]);

  const onCategoriesChange = (next: string[]) => {
    const cats = next.filter((v): v is ComposeCategory =>
      categoryOptions.includes(v as ComposeCategory),
    );
    setSelectedCategories(cats);
    const dirs = cats.filter((c): c is DirectoryComposeCategory => c !== "other");
    setSelectedKeys((prev) => mergeAdminComposePersonKey(dirs, prev));
  };

  const resolveEmailTargets = () => {
    const labels: string[] = [];
    const directEmails: string[] = [];
    let includesAxisAdmin = false;
    let includesDirectoryRecipients = false;
    const broadcastCategories: ("management" | "resident")[] = [];
    const seenBroadcast = new Set<string>();
    const seenEmail = new Set<string>();

    for (const key of selectedKeys) {
      if (key === "admin") {
        const stub = broadcastStubForCategory("admin");
        includesAxisAdmin = true;
        labels.push(PRIMARY_AXIS_ADMIN_LABEL);
        const email = stub.email.trim().toLowerCase();
        if (!seenEmail.has(email)) {
          seenEmail.add(email);
          directEmails.push(stub.email.trim());
        }
        continue;
      }
      if (key === "broadcast:management") {
        if (!seenBroadcast.has("management")) {
          seenBroadcast.add("management");
          broadcastCategories.push("management");
          labels.push("All management");
          includesDirectoryRecipients = true;
        }
        continue;
      }
      if (key === "broadcast:resident") {
        if (!seenBroadcast.has("resident")) {
          seenBroadcast.add("resident");
          broadcastCategories.push("resident");
          labels.push("All residents");
          includesDirectoryRecipients = true;
        }
        continue;
      }
      if (key.startsWith("house:")) {
        // Resolved at SEND time, not when the picker was opened, so a resident
        // who moved in since is included (PRP-150). Only CURRENT residents —
        // "everyone at Brooklyn House" must not reach an applicant or someone
        // who has moved out, which is the whole point of the section split.
        const propertyId = key.slice("house:".length);
        const members = contacts.filter(
          (c) =>
            c.role === "resident" &&
            (c.tenancyStatus ?? "resident") === "resident" &&
            c.propertyId?.trim() === propertyId,
        );
        if (members.length === 0) continue;
        labels.push(`Everyone at ${members[0]!.propertyLabel?.trim() || "this house"}`);
        includesDirectoryRecipients = true;
        for (const member of members) {
          const memberEmail = member.email.trim();
          const memberLower = memberEmail.toLowerCase();
          if (!memberLower || seenEmail.has(memberLower)) continue;
          seenEmail.add(memberLower);
          directEmails.push(memberEmail);
        }
        continue;
      }
      const id = key.slice(3);
      const contact = contacts.find((c) => c.id === id);
      if (!contact) continue;
      labels.push(contact.name);
      includesDirectoryRecipients = true;
      const email = contact.email.trim();
      const lower = email.toLowerCase();
      if (!lower || seenEmail.has(lower)) continue;
      seenEmail.add(lower);
      directEmails.push(email);
      if (lower === broadcastStubForCategory("admin").email.toLowerCase()) {
        includesAxisAdmin = true;
      }
    }

    const other = otherSelected
      ? parseOtherRecipientTokens(otherTokens)
      : { emails: [] as string[], phones: [] as string[] };
    for (const email of other.emails) {
      const lower = email.toLowerCase();
      if (seenEmail.has(lower)) continue;
      seenEmail.add(lower);
      directEmails.push(email);
      labels.push(email);
      includesDirectoryRecipients = true;
    }

    return {
      labels,
      directEmails,
      includesAxisAdmin,
      includesDirectoryRecipients,
      broadcastCategories,
    };
  };

  const resolveSmsTargets = () => {
    const targets: { phone: string; residentUserId?: string | null }[] = [];
    const seen = new Set<string>();
    const add = (phone: string | null | undefined, residentUserId?: string | null) => {
      const e164 = phone ? normalizePhoneE164(phone) : null;
      if (!e164 || seen.has(e164)) return;
      seen.add(e164);
      targets.push({ phone: e164, residentUserId });
    };

    const wantsAllResidents = selectedKeys.includes("broadcast:resident");
    if (wantsAllResidents) {
      for (const r of withPhone) add(r.phone, r.residentUserId);
    }

    for (const key of selectedKeys) {
      if (!key.startsWith("id:")) continue;
      const id = key.slice(3);
      const contact = contacts.find((c) => c.id === id);
      if (!contact) continue;
      const email = contact.email.trim().toLowerCase();
      const byEmail = withPhone.find((r) => r.residentEmail?.trim().toLowerCase() === email);
      if (byEmail) {
        add(byEmail.phone, byEmail.residentUserId);
        continue;
      }
      const byName = withPhone.find(
        (r) => r.name.trim().toLowerCase() === contact.name.trim().toLowerCase(),
      );
      if (byName) add(byName.phone, byName.residentUserId);
    }

    if (otherSelected) {
      for (const phone of parseOtherRecipientTokens(otherTokens).phones) {
        add(phone, null);
      }
    }

    return targets;
  };

  const submit = async () => {
    if (!viaEmail && !viaSms) {
      showToast("Choose Email and/or SMS at the bottom.");
      return;
    }
    const text = body.trim();
    if (!text) {
      showToast("Write a message.");
      return;
    }
    if (selectedCategories.length === 0) {
      showToast("Select at least one section under To.");
      return;
    }
    const other = otherSelected
      ? parseOtherRecipientTokens(otherTokens)
      : { emails: [] as string[], phones: [] as string[] };
    if (otherSelected && other.emails.length === 0 && other.phones.length === 0) {
      showToast("Type an email or phone under Other.");
      return;
    }
    if (directoryCategories.length > 0 && selectedKeys.length === 0) {
      showToast("Select at least one person from Which people.");
      return;
    }

    if (viaEmail) {
      const s = subject.trim();
      if (!s) {
        showToast("Add a subject for email.");
        return;
      }
      const emailTargets = resolveEmailTargets();
      if (
        !emailTargets.includesAxisAdmin &&
        emailTargets.broadcastCategories.length === 0 &&
        emailTargets.directEmails.length === 0
      ) {
        showToast("Add at least one email recipient (directory or Other).");
        return;
      }
    }

    if (viaSms) {
      const smsTargets = resolveSmsTargets();
      if (smsTargets.length === 0) {
        showToast("Add at least one phone (resident with a number, or Other).");
        return;
      }
    }

    if (scheduleLater) {
      const when = new Date(sendAt);
      if (Number.isNaN(when.getTime())) {
        showToast("Choose a valid send date and time.");
        return;
      }
      if (when.getTime() < Date.now() - 60_000) {
        showToast("Send time must be in the future.");
        return;
      }
      const s = subject.trim();
      setSending(true);
      try {
        const emailTargets = viaEmail ? resolveEmailTargets() : null;
        const schedulePayloads: Record<string, unknown>[] = [];
        if (emailTargets) {
          for (const category of emailTargets.broadcastCategories) {
            schedulePayloads.push({
              subject: s,
              body: text,
              sendAt: when.toISOString(),
              broadcastCategories: [category],
              deliverViaEmail: true,
              deliverViaSms: viaSms,
            });
          }
          for (const email of emailTargets.directEmails) {
            schedulePayloads.push({
              subject: s,
              body: text,
              sendAt: when.toISOString(),
              recipientEmail: email,
              recipientName: email,
              deliverViaEmail: true,
              deliverViaSms: viaSms,
            });
          }
        }
        if (schedulePayloads.length === 0 && viaSms) {
          const smsTargets = resolveSmsTargets();
          if (smsTargets.length === 0) {
            showToast("Add at least one recipient to schedule.");
            return;
          }
          schedulePayloads.push(
            ...buildSmsSchedulePayloads({
              targets: smsTargets,
              subject: s,
              body: text,
              sendAt: when.toISOString(),
            }),
          );
        }
        if (schedulePayloads.length === 0) {
          showToast("Add at least one recipient to schedule.");
          return;
        }
        const results = await Promise.all(schedulePayloads.map((payload) => postScheduledInboxMessage(payload)));
        if (results.some((ok) => !ok)) {
          showToast("Some messages could not be scheduled.");
          return;
        }
        showToast(
          schedulePayloads.length === 1 ? "Message scheduled." : `${schedulePayloads.length} messages scheduled.`,
        );
        onClose();
        onSent?.({ email: viaEmail, sms: viaSms });
      } finally {
        setSending(false);
      }
      return;
    }

    setSending(true);
    let emailOk = !viaEmail;
    let smsOk = !viaSms;
    let lastError = "Could not send.";
    let smsOutcomeUnknown = false;
    let optimisticId: string | null = null;
    let primaryRecipientEmail: string | undefined;

    if (viaEmail) {
      const emailTargets = resolveEmailTargets();
      if (
        emailTargets.directEmails.length === 1 &&
        emailTargets.broadcastCategories.length === 0
      ) {
        primaryRecipientEmail = emailTargets.directEmails[0];
        const optimistic = buildOptimisticSentThread({
          recipientEmail: primaryRecipientEmail,
          subject: subject.trim(),
          body: text,
          senderLabel: senderName,
        });
        optimisticId = optimistic.id;
        onStageOptimistic?.(optimistic);
      }
    }

    try {
      if (viaEmail) {
        const emailTargets = resolveEmailTargets();
        if (emailTargets.includesAxisAdmin && isDemoModeActive()) {
          appendPortalMessageToAdminInbox({
            role: "manager",
            name: senderName,
            email: senderEmail,
            topic: subject.trim(),
            body: text,
          });
        }
        const res = await fetch("/api/portal/send-inbox-message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            fromName: senderName,
            fromEmail: senderEmail,
            toEmails: emailTargets.directEmails,
            toBroadcast: emailTargets.broadcastCategories,
            subject: subject.trim(),
            text,
            deliverToPortalInbox: true,
            deliverViaSms: false,
            eventCategory: "messages",
            senderPortal: "manager",
          }),
        });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!res.ok || !data.ok) {
          lastError = data.error ?? "Email could not be sent.";
        } else {
          emailOk = true;
          invalidatePersistedInboxCache(MANAGER_INBOX_STORAGE_KEY);
          void syncPersistedInboxFromServer(MANAGER_INBOX_STORAGE_KEY, { force: true });
        }
      }

      if (viaSms) {
        const smsTargets = resolveSmsTargets();
        const attempt = resolveManualSmsAttempt(
          smsAttemptRef.current,
          JSON.stringify([
            text,
            ...smsTargets.map((target) => [
              target.phone,
              target.residentUserId ?? null,
            ]),
          ]),
          smsTargets.length,
        );
        smsAttemptRef.current = attempt;
        let sent = 0;
        for (const [index, target] of smsTargets.entries()) {
          try {
            const res = await fetch("/api/manager/sms-conversations", {
              method: "POST",
              credentials: "include",
              headers: {
                "Content-Type": "application/json",
                "Idempotency-Key": attempt.idempotencyKeys[index]!,
              },
              body: JSON.stringify({
                toPhone: target.phone,
                text,
                residentUserId: target.residentUserId ?? undefined,
              }),
            });
            const data = (await res.json().catch(() => ({}))) as {
              code?: string;
              error?: string;
              status?: string;
            };
            if (isManualSmsOutcomeUnknown(data)) {
              smsOutcomeUnknown = true;
              lastError = MANUAL_SMS_UNKNOWN_MESSAGE;
              continue;
            }
            if (!res.ok) {
              lastError = data.error ?? lastError;
              continue;
            }
            sent += 1;
          } catch {
            smsOutcomeUnknown = true;
            lastError = MANUAL_SMS_UNKNOWN_MESSAGE;
            continue;
          }
        }
        smsOk = sent > 0 && !smsOutcomeUnknown;
        if (!smsOutcomeUnknown) smsAttemptRef.current = null;
        if (!smsOk) lastError = lastError === "Could not send." ? "SMS could not be sent." : lastError;
      }

      if (smsOutcomeUnknown) {
        if (optimisticId) onClearOptimistic?.(optimisticId);
        showToast(
          viaEmail && emailOk
            ? `Email sent. ${MANUAL_SMS_UNKNOWN_MESSAGE}`
            : MANUAL_SMS_UNKNOWN_MESSAGE,
        );
        return;
      }

      if ((viaEmail && !emailOk) || (viaSms && !smsOk)) {
        if (optimisticId) onClearOptimistic?.(optimisticId);
        if (viaEmail && emailOk && viaSms && !smsOk) {
          showToast("Email sent, but SMS failed.");
          onClose();
          onSent?.({ email: true, sms: false, primaryRecipientEmail });
          return;
        }
        if (viaSms && smsOk && viaEmail && !emailOk) {
          showToast("SMS sent, but email failed.");
          onClose();
          onSent?.({ email: false, sms: true, primaryRecipientEmail });
          return;
        }
        showToast(lastError);
        return;
      }

      if (optimisticId) onClearOptimistic?.(optimisticId);

      const both = viaEmail && viaSms;
      showToast(both ? "Message sent via email and SMS." : viaSms ? "SMS sent." : "Message sent.");
      onClose();
      onSent?.({ email: viaEmail, sms: viaSms, primaryRecipientEmail });
    } catch {
      if (optimisticId) onClearOptimistic?.(optimisticId);
      showToast(lastError);
    } finally {
      setSending(false);
    }
  };

  const sendLabel = (() => {
    if (sending) return "Sending…";
    if (scheduleLater) return "Schedule";
    if (viaEmail && viaSms) return "Send message";
    if (viaSms) return "Send SMS";
    return "Send email";
  })();

  return (
    <Modal
      open={open}
      title="New message"
      onClose={onClose}
      dense
      panelClassName={PORTAL_MESSAGE_COMPOSE_MODAL_PANEL_CLASS}
      footer={
        <ModalFooter>
          <Button
            type="button"
            variant="primary"
            className="rounded-full"
            data-attr="communication-compose-send"
            disabled={sending || (!viaEmail && !viaSms)}
            onClick={() => submit()}
          >
            {sendLabel}
          </Button>
        </ModalFooter>
      }
    >
      <PortalMessageComposeModalBody>
        <PortalMessageComposeRecipientSection
          sectionOptions={sectionOptions}
          selectedCategories={selectedCategories}
          onCategoriesChange={onCategoriesChange}
          sectionDataAttr="communication-compose-category"
          personGroups={personGroups}
          selectedKeys={selectedKeys}
          onPeopleChange={(next) => setSelectedKeys(next as PersonKey[])}
          peopleDisabled={directoryCategories.length === 0 || adminOnlyDirectory}
          peopleEmptyMenuText={
            selectedCategories.length === 0
              ? "Pick a section first"
              : adminOnlyDirectory
                ? "PropLane admin is the recipient"
                : directoryCategories.length === 0
                  ? "Other uses the field below"
                  : "No contacts in selected sections"
          }
        />

        {selectedCategories.includes("other") ? (
          <div data-attr="communication-compose-other-wrap">
            <label className={portalMessageFieldLabel()} htmlFor="communication-compose-other">
              Other
            </label>
            <RecipientChipsInput
              id="communication-compose-other"
              tokens={otherTokens}
              onChange={setOtherTokens}
              placeholder={
                viaSms && !viaEmail
                  ? "Type a phone, then press Space…"
                  : viaEmail && !viaSms
                    ? "Type an email, then press Space…"
                    : "Type email or phone, then press Space…"
              }
              dataAttr="communication-compose-other"
            />
            <p className="mt-1 text-xs text-muted">Press Space, comma, or Enter to save each recipient as a chip.</p>
          </div>
        ) : null}

        <div className={PORTAL_MESSAGE_COMPOSE_TWO_COL_CLASS}>
          <PortalMessageSubjectField
            value={subject}
            onChange={setSubject}
            dataAttr="communication-compose-subject"
          />

          <PortalMessageSendViaDropdown
            selected={sendVia}
            onChange={setSendVia}
            emailAvailable
            smsAvailable={smsUiEnabled}
            footerNote={
              smsUiEnabled
                ? portalMessageSendViaFooterNote(true)
                : portalMessageSendViaFooterNote(false)
            }
            dataAttr="communication-compose-send-via"
          />
        </div>

        <PortalMessageBodyField
          value={body}
          onChange={setBody}
          placeholder="Write your message…"
          minHeightClass="min-h-[7rem]"
          maxLength={viaSms ? 1600 : undefined}
          showCharCount={viaSms}
          dataAttr="communication-compose-body"
        />

        <PortalMessageScheduleFields
          scheduleLater={scheduleLater}
          onScheduleLaterChange={setScheduleLater}
          sendAt={sendAt}
          onSendAtChange={setSendAt}
          scheduleDataAttr="communication-compose-schedule-later"
          sendAtDataAttr="communication-compose-schedule-at"
        />
      </PortalMessageComposeModalBody>
    </Modal>
  );
}
