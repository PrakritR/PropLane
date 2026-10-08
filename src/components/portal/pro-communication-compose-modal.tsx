"use client";

import { PopupMessagePreview, PopupRecordPreview } from "@/components/portal/popup-live-preview";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, Mail, Smartphone, MessageSquare, Paperclip, Sparkles } from "lucide-react";
import { InboxComposerScheduleMenu } from "@/components/portal/inbox-composer-tools";
import { INBOX_ATTACHMENT_ACCEPT, INBOX_MAX_ATTACHMENTS, createPendingInboxAttachment, uploadInboxAttachment, revokeInboxAttachmentPreview, type InboxComposerAttachment } from "@/lib/inbox-attachments";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { type CheckboxMultiSelectGroup } from "@/components/ui/checkbox-multi-select";
import {
  defaultPortalMessageChannelSelection,
  defaultPortalMessageScheduleAt,
  PortalMessageBodyField,
  PortalMessageComposeModalBody,
  PortalMessageSubjectField,
  portalMessageChannelsFromSelection,
  portalMessageFieldLabel,
} from "@/components/portal/portal-message-compose-fields";
import { useManagerCommunicationDeliverVia } from "@/hooks/use-manager-communication-deliver-via";
import { portalMessageSelectionFromDeliverVia } from "@/lib/manager-communication-deliver-via";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { vendorDetailHref } from "@/lib/portal-detail-routes";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { mergeInboxScopedContacts } from "@/lib/manager-inbox-contacts";
import {
  composeDirectoryCategories,
  composeValidPersonKeys,
  houseComposeCategoryLabel,
  houseIdFromComposeCategory,
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
import { parseOtherRecipientTokens, commitOtherRecipientToken, normalizePhoneE164, type OtherRecipientToken } from "@/lib/communication-other-recipients";
import type { ManagerComposePrefill } from "@/lib/manager-compose-prefill";
import type { ResidentComposePrefill } from "@/lib/resident-compose-prefill";
import { DEMO_INBOX_COMPOSE_PREFILL_EVENT } from "@/lib/demo/demo-playback";
import {
  composeCategoryForContact,
  roleComposeCapabilities,
  scopedComposeCategories,
  scopedPeopleForCategory,
  type ComposePortal,
  type ScopedInboxSendPayload,
} from "@/lib/role-compose";
import { buildOptimisticSentThread } from "@/lib/inbox-message-timeline";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";
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
 * The one New message composer, for every role.
 *
 * Manager (default): To / Subject / Message, Email and/or In-app and/or Text,
 * schedule, attach, Draft with PropLane. Vendor and resident mount the same
 * composer with `portal` and their own `onSend`: their recipients are the
 * scoped list they are handed (`liveContacts`), the capabilities come from
 * `roleComposeCapabilities`, and the panel's send function owns the request
 * and the thread store (a message enters the store only after the send is
 * authorized). The server re-authorizes every recipient.
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
  portal = "manager",
  onSend,
  residentDraft = null,
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
  /** Whose composer this is. Vendor and resident are scoped: their own people, channels and send. */
  portal?: ComposePortal;
  /** Vendor and resident: the panel's send function. Return false (or throw) to keep the draft. */
  onSend?: (payload: ScopedInboxSendPayload) => void | boolean | Promise<void | boolean>;
  /** Resident: a staged draft from another section (recipient, subject, body, property). */
  residentDraft?: ResidentComposePrefill | null;
}) {
  const isManager = portal === "manager";
  const caps = useMemo(() => roleComposeCapabilities(portal, smsUiEnabled), [portal, smsUiEnabled]);
  const { showToast } = useAppUi();
  const [directoryContacts, setDirectoryContacts] = useState<InboxScopedContact[]>([]);
  const localContacts = useMemo(() => contactsForPortal(portal, liveContacts), [portal, liveContacts]);
  const contacts = directoryContacts.length > 0 ? directoryContacts : localContacts;
  /** Other sits last, under Vendor. */
  const categoryOptions = useMemo((): ComposeCategory[] => {
    if (!isManager) return scopedComposeCategories(portal as Exclude<ComposePortal, "manager">, contacts);
    return [...composeDirectoryCategories("manager", contacts), "other"];
  }, [contacts, isManager, portal]);

  const [selectedCategories, setSelectedCategories] = useState<ComposeCategory[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<PersonKey[]>([]);
  const [otherTokens, setOtherTokens] = useState<OtherRecipientToken[]>([]);
  const [attachments, setAttachments] = useState<InboxComposerAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  const [drafting, setDrafting] = useState(false);
  useEffect(() => () => { attachmentsRef.current.forEach(revokeInboxAttachmentPreview); }, []);
  const [recipientQuery, setRecipientQuery] = useState("");
  const [recipientOpen, setRecipientOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sendVia, setSendVia] = useState<string[]>(["email"]);
  /** "This is a vendor": a typed phone number nobody has on the list is added to Vendors with the text. */
  const [markVendor, setMarkVendor] = useState(false);
  /** "I work with this vendor": the manager's attestation, only for a first text to a vendor with no consent yet. */
  const [attestVendor, setAttestVendor] = useState(false);
  const [vendorTextStatus, setVendorTextStatus] = useState<Record<string, { needsAttestation: boolean; optedOut: boolean; senderLine?: string }>>({});
  const [scheduleLater, setScheduleLater] = useState(false);
  const [sendAt, setSendAt] = useState(defaultPortalMessageScheduleAt);
  const [sending, setSending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const smsAttemptRef = useRef<ManualSmsAttempt | null>(null);
  const { channelsFor } = useManagerCommunicationDeliverVia({ enabled: isManager });
  const [propertyContext, setPropertyContext] = useState<{
    propertyId?: string;
    propertyTitle?: string;
    managerUserId?: string;
  } | null>(null);
  const sendOperationRef = useRef<{ fingerprint: string; id: string } | null>(null);

  const { viaEmail, viaSms } = portalMessageChannelsFromSelection(sendVia);
  const viaInbox = sendVia.includes("proplane");
  const viaPortalDelivery = viaEmail || viaInbox;

  const withPhone = useMemo(
    () => smsRecipients.filter((r) => Boolean(r.phone?.trim())),
    [smsRecipients],
  );

  const otherSelected = selectedCategories.includes("other");
  const directoryCategories = useMemo(
    () => selectedCategories.filter((c): c is DirectoryComposeCategory => c !== "other"),
    [selectedCategories],
  );

  const peopleFor = useCallback(
    (category: DirectoryComposeCategory): { key: PersonKey; label: string }[] =>
      isManager ? peopleForCategory(category, contacts) : scopedPeopleForCategory(category, portal, contacts),
    [contacts, isManager, portal],
  );
  const recipientOptions = useMemo(() => {
    const seen = new Set<string>();
    return categoryOptions.filter((category): category is DirectoryComposeCategory => category !== "other")
      .flatMap((category) => peopleFor(category).map((person) => ({ ...person, category })))
      .filter((person) => { if (seen.has(person.key)) return false; seen.add(person.key); return true; });
  }, [categoryOptions, peopleFor]);
  const personGroups = useMemo((): CheckboxMultiSelectGroup[] => {
    return directoryCategories
      .map((category) => ({
        label: categoryLabel(category, contacts),
        options: peopleFor(category).map((p) => ({
          value: p.key,
          label: p.label,
        })),
      }))
      .filter((g) => g.options.length > 0);
  }, [directoryCategories, contacts, peopleFor]);

  const flatPersonOptions = useMemo(() => personGroups.flatMap((g) => g.options), [personGroups]);
  const validPersonKeys = useMemo(
    () => composeValidPersonKeys(flatPersonOptions.map((o) => o.value), directoryCategories),
    [directoryCategories, flatPersonOptions],
  );

  useEffect(() => {
    // Vendor and resident compose from the scoped list they are handed.
    if (!open || !isManager) return;
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
  }, [open, isManager, localContacts]);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      if (!isManager) {
        if (residentDraft) {
          setSubject(residentDraft.subject?.trim() || "");
          setBody(residentDraft.body?.trim() || "");
          setPropertyContext({
            propertyId: residentDraft.propertyId?.trim() || undefined,
            propertyTitle: residentDraft.propertyTitle?.trim() || undefined,
            managerUserId: residentDraft.managerUserId?.trim() || undefined,
          });
        } else {
          setSubject("");
          setBody("");
          setPropertyContext(null);
          setSelectedCategories([]);
          setSelectedKeys([]);
        }
        setOtherTokens([]);
        setSendVia([...caps.defaultChannels]);
        attachmentsRef.current.forEach(revokeInboxAttachmentPreview);
        setAttachments([]);
        setRecipientQuery("");
        setRecipientOpen(false);
        setFormError(null);
        setScheduleLater(false);
        setSendAt(defaultPortalMessageScheduleAt());
        setSending(false);
        sendOperationRef.current = null;
        return;
      }
      const email = initialDraft?.recipientEmail?.trim().toLowerCase();
      const vendorRecordId = initialDraft?.vendorRecordId?.trim();
      if (initialDraft) {
        setSubject(initialDraft.subject);
        setBody(initialDraft.body);
        if (vendorRecordId) {
          // Opened from a vendor's "Text": that vendor, by text.
          setSelectedCategories(["vendor"]);
          setSelectedKeys([`id:ven-${vendorRecordId}`]);
          setOtherTokens([]);
        } else if (email) {
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
      setAttestVendor(false);
      setSendVia(
        initialDraft?.vendorRecordId && smsUiEnabled
          ? ["sms"]
          : initialDraft?.recipientEmail && initialChannel === "sms"
          ? defaultPortalMessageChannelSelection(true, smsUiEnabled, false, true)
          : portalMessageSelectionFromDeliverVia(
              channelsFor("inbox_default"),
              smsUiEnabled,
            ),
      );
      attachmentsRef.current.forEach(revokeInboxAttachmentPreview);
      setAttachments([]);
      setRecipientQuery("");
      setRecipientOpen(false);
      setScheduleLater(false);
      setSendAt(defaultPortalMessageScheduleAt());
      setSending(false);
      smsAttemptRef.current = null;
    });
  }, [open, initialChannel, smsUiEnabled, initialDraft, channelsFor, isManager, residentDraft, caps]);

  // A staged resident draft names its manager: pick them once the list is here.
  useEffect(() => {
    if (!open || isManager || !residentDraft || contacts.length === 0) return;
    const email = residentDraft.recipientEmail?.trim().toLowerCase();
    const managerId = residentDraft.managerUserId?.trim();
    const hit =
      (managerId
        ? contacts.find((c) => c.id === `mgr-${managerId}` || c.id === managerId)
        : undefined) ??
      (email ? contacts.find((c) => c.email.trim().toLowerCase() === email) : undefined);
    if (!hit) return;
    setSelectedCategories([composeCategoryForContact(portal, hit)]);
    setSelectedKeys([`id:${hit.id}` as PersonKey]);
  }, [open, isManager, portal, residentDraft, contacts]);

  // Demo playback types a message into the open composer.
  useEffect(() => {
    if (!isDemoModeActive()) return;
    const onPrefill = (e: Event) => {
      const detail = (e as CustomEvent<{ subject?: string; body?: string; residentEmail?: string }>).detail;
      setSubject(detail?.subject?.trim() || "Lease renewal reminder");
      setBody(
        detail?.body?.trim() ||
          "Hi, just a friendly reminder that your lease renewal paperwork is ready whenever you want to review it.",
      );
      const email = detail?.residentEmail?.trim().toLowerCase();
      if (email) {
        const hit = contacts.find((c) => c.email?.toLowerCase() === email);
        if (hit) {
          setSelectedCategories([composeCategoryForContact(portal, hit)]);
          setSelectedKeys([`id:${hit.id}` as PersonKey]);
        }
      }
    };
    window.addEventListener(DEMO_INBOX_COMPOSE_PREFILL_EVENT, onPrefill as EventListener);
    return () => window.removeEventListener(DEMO_INBOX_COMPOSE_PREFILL_EVENT, onPrefill as EventListener);
  }, [contacts, portal]);

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

  const resolveEmailTargets = () => {
    const labels: string[] = [];
    const directEmails: string[] = [];
    const directRecipientUserIds: string[] = [];
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
      if (contact.userId?.trim()) directRecipientUserIds.push(contact.userId.trim());
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
      directRecipientUserIds: [...new Set(directRecipientUserIds)],
      includesAxisAdmin,
      includesDirectoryRecipients,
      broadcastCategories,
    };
  };

  const resolveSmsTargets = () => {
    const targets: { phone: string; residentUserId?: string | null; vendorRecordId?: string }[] = [];
    const seen = new Set<string>();
    const add = (phone: string | null | undefined, residentUserId?: string | null, vendorRecordId?: string) => {
      const e164 = phone ? normalizePhoneE164(phone) : null;
      if (!e164 || seen.has(e164)) return;
      seen.add(e164);
      targets.push({ phone: e164, residentUserId, ...(vendorRecordId ? { vendorRecordId } : {}) });
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
      if (contact.role === "vendor") {
        // A vendor texts its OWN saved phone (the roster row), never a name match to a resident.
        if (contact.phone) add(contact.phone, null, id.replace(/^ven-/, ""));
        continue;
      }
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

  // Roster vendors picked in To who will be texted at their own saved phone.
  const vendorSmsRecordIds = useMemo(
    () =>
      selectedKeys.flatMap((key) => {
        if (!key.startsWith("id:")) return [];
        const contact = contacts.find((c) => c.id === key.slice(3));
        return contact?.role === "vendor" && contact.phone ? [contact.id.replace(/^ven-/, "")] : [];
      }),
    [selectedKeys, contacts],
  );
  const vendorSmsRecordKey = vendorSmsRecordIds.join(",");
  useEffect(() => {
    if (!open || !viaSms || vendorSmsRecordIds.length === 0 || isDemoModeActive()) return;
    let active = true;
    for (const recordId of vendorSmsRecordIds) {
      void fetch(`/api/manager/vendor-text-consent?vendorRecordId=${encodeURIComponent(recordId)}`, {
        credentials: "include",
        cache: "no-store",
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { needsAttestation?: boolean; optedOut?: boolean; senderLine?: string } | null) => {
          if (!active || !data) return;
          setVendorTextStatus((previous) => ({
            ...previous,
            [recordId]: {
              needsAttestation: data.needsAttestation === true,
              optedOut: data.optedOut === true,
              ...(data.senderLine ? { senderLine: data.senderLine } : {}),
            },
          }));
        })
        .catch(() => undefined);
    }
    return () => {
      active = false;
    };
    // vendorSmsRecordKey is the stable identity of vendorSmsRecordIds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, viaSms, vendorSmsRecordKey]);
  const attestationVendors = vendorSmsRecordIds.filter((id) => vendorTextStatus[id]?.needsAttestation);
  const attestationSenderLine = attestationVendors.map((id) => vendorTextStatus[id]?.senderLine).find(Boolean);
  useEffect(() => {
    if (attestationVendors.length === 0) setAttestVendor(false);
  }, [attestationVendors.length]);

  /**
   * Why a send did not happen, shown INSIDE the modal.
   *
   * These used to be toast-only. A toast is transient and renders in a
   * fixed-position layer under the dialog, so clicking Send with an empty form
   * read as a silent no-op — the user could not tell whether it had sent, to
   * whom, or why not. The modal already stays open (the draft is never
   * discarded); this is the half that explains itself.
   */
  const fail = (message: string) => {
    setFormError(message);
    showToast(message);
  };

  const draftMessage = async () => {
    const targets = resolveEmailTargets();
    const email = targets.directEmails[0];
    if (!email || targets.directEmails.length !== 1 || targets.broadcastCategories.length) {
      setFormError("Choose one recipient with an email address to draft a message."); return;
    }
    setDrafting(true); setFormError(null);
    try {
      const response = await fetch("/api/portal/inbox-draft-reply", {method: "POST", credentials: "include", headers: {"Content-Type": "application/json"}, body: JSON.stringify({residentEmail: email, residentName: targets.labels[0] || email})});
      const result = await response.json() as {ok?: boolean; error?: string; draft?: {text?: string}};
      if (!response.ok || !result.ok || !result.draft?.text) throw new Error(result.error || "Could not draft a message.");
      setBody(result.draft.text);
    } catch (error) { setFormError(error instanceof Error ? error.message : "Could not draft a message."); }
    finally { setDrafting(false); }
  };
  const pickAttachments = (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files).slice(0, INBOX_MAX_ATTACHMENTS - attachmentsRef.current.length)) {
      const pending = createPendingInboxAttachment(file);
      setAttachments((previous) => [...previous, pending]);
      void uploadInboxAttachment(file).then((uploadUrl) => setAttachments((previous) => previous.map((item) => item.id === pending.id ? {...item, uploadUrl, uploading: false} : item)))
        .catch((error) => setAttachments((previous) => previous.map((item) => item.id === pending.id ? {...item, uploading: false, error: error instanceof Error ? error.message : "Upload failed"} : item)));
    }
  };

  const submit = async () => {
    if (attachments.some((item) => item.uploading || item.error)) {setFormError("Wait for uploads to finish or remove failed attachments."); return;}
    if (attachments.length && (scheduleLater || viaSms)) {setFormError(scheduleLater ? "Scheduled attachments are not supported. Remove the files or send now." : "Attachments can be sent by Email or In-app. Turn off Text message to send these files."); return;}

    if (recipientQuery.trim()) { setFormError("Press Enter to add the recipient before sending."); return; }
    setFormError(null);
    if (!viaPortalDelivery && !viaSms) {
      fail("Choose Email and/or SMS at the bottom.");
      return;
    }
    const text = body.trim();
    if (!text && attachments.length === 0) {
      fail("Write a message.");
      return;
    }
    if (selectedCategories.length === 0) {
      fail("Choose a recipient.");
      return;
    }
    const other = otherSelected
      ? parseOtherRecipientTokens(otherTokens)
      : { emails: [] as string[], phones: [] as string[] };
    if (otherSelected && other.emails.length === 0 && other.phones.length === 0) {
      fail("Enter an email or phone number.");
      return;
    }
    if (directoryCategories.length > 0 && selectedKeys.length === 0) {
      fail("Choose a recipient.");
      return;
    }

    if (viaPortalDelivery) {
      const s = subject.trim();
      if (viaEmail && !s) {
        fail("Add a subject for email.");
        return;
      }
      const emailTargets = resolveEmailTargets();
      if (
        !emailTargets.includesAxisAdmin &&
        emailTargets.broadcastCategories.length === 0 &&
        emailTargets.directEmails.length === 0
      ) {
        fail("Add at least one email recipient (directory or Other).");
        return;
      }
    }

    if (viaSms) {
      const smsTargets = resolveSmsTargets();
      if (smsTargets.length === 0) {
        fail("Add at least one phone (resident with a number, or Other).");
        return;
      }
      const vendorTargets = smsTargets.filter((target) => target.vendorRecordId);
      if (vendorTargets.some((target) => vendorTextStatus[target.vendorRecordId!]?.optedOut)) {
        fail("That number has opted out of texts.");
        return;
      }
      if (vendorTargets.length > 0 && scheduleLater) {
        fail("A text to a vendor sends now. Turn off Schedule, or schedule an email instead.");
        return;
      }
      if (vendorTargets.some((target) => vendorTextStatus[target.vendorRecordId!]?.needsAttestation) && !attestVendor) {
        fail("Confirm you work with this vendor to send the first text.");
        return;
      }
    }

    if (scheduleLater) {
      const when = new Date(sendAt);
      if (Number.isNaN(when.getTime())) {
        fail("Choose a valid send date and time.");
        return;
      }
      if (when.getTime() < Date.now() - 60_000) {
        fail("Send time must be in the future.");
        return;
      }
      const s = subject.trim();
      setSending(true);
      try {
        const emailTargets = viaPortalDelivery ? resolveEmailTargets() : null;
        const schedulePayloads: Record<string, unknown>[] = [];
        if (emailTargets) {
          for (const category of emailTargets.broadcastCategories) {
            schedulePayloads.push({
              subject: s,
              body: text,
              sendAt: when.toISOString(),
              broadcastCategories: [category],
              deliverViaEmail: viaEmail,
              deliverViaInbox: viaInbox,
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
              deliverViaEmail: viaEmail,
              deliverViaInbox: viaInbox,
              deliverViaSms: viaSms,
            });
          }
        }
        if (schedulePayloads.length === 0 && viaSms) {
          const smsTargets = resolveSmsTargets();
          if (smsTargets.length === 0) {
            fail("Add at least one recipient to schedule.");
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
          fail("Add at least one recipient to schedule.");
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
    let emailOk = !viaPortalDelivery;
    let smsOk = !viaSms;
    let lastError = "Could not send.";
    let smsOutcomeUnknown = false;
    let vendorTexted: { vendorId: string; name: string; created: boolean } | null = null;
    let optimisticId: string | null = null;
    let primaryRecipientEmail: string | undefined;

    if (viaPortalDelivery) {
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
      if (viaPortalDelivery) {
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
            subject: subject.trim() || "Message",
            attachmentUrls: attachments.flatMap((item) => item.uploadUrl ? [item.uploadUrl] : []),
            text,
            deliverToPortalInbox: viaInbox || viaEmail,
            deliverViaEmail: viaEmail,
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
              target.vendorRecordId ?? null,
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
                ...(target.vendorRecordId
                  ? { vendorRecordId: target.vendorRecordId, attestVendorRelationship: attestVendor }
                  : {}),
                ...(markVendor && !target.residentUserId && !target.vendorRecordId ? { isVendor: true } : {}),
              }),
            });
            const data = (await res.json().catch(() => ({}))) as {
              code?: string;
              error?: string;
              status?: string;
              vendor?: { vendorId: string; name: string; created: boolean };
            };
            if (isManualSmsOutcomeUnknown(data)) {
              smsOutcomeUnknown = true;
              lastError = MANUAL_SMS_UNKNOWN_MESSAGE;
              continue;
            }
            if (!res.ok) {
              lastError = data.error ?? lastError;
              if (data.code === "vendor_attestation_required" && target.vendorRecordId) {
                setVendorTextStatus((previous) => ({
                  ...previous,
                  [target.vendorRecordId!]: { ...previous[target.vendorRecordId!], needsAttestation: true, optedOut: false },
                }));
              }
              continue;
            }
            sent += 1;
            if (data.vendor) vendorTexted = data.vendor;
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

      if ((viaPortalDelivery && !emailOk) || (viaSms && !smsOk)) {
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
      const sentMessage = both ? "Message sent via email and SMS." : viaSms ? "SMS sent." : "Message sent.";
      if (vendorTexted) {
        // The number is a vendor: say so, and Open goes straight to them.
        const vendor = vendorTexted;
        showToast(vendor.created ? `${sentMessage} Added to Vendors · ${vendor.name}` : sentMessage, {
          actionLabel: "Open",
          undo: () => window.location.assign(vendorDetailHref("/portal", vendor.vendorId)),
        });
      } else if (viaSms) {
        showToast(sentMessage, {
          actionLabel: "Open",
          undo: () => window.location.assign("/portal/communication/active"),
        });
      } else {
        showToast(sentMessage);
      }
      onClose();
      onSent?.({ email: viaEmail, sms: viaSms, primaryRecipientEmail });
    } catch {
      if (optimisticId) onClearOptimistic?.(optimisticId);
      showToast(lastError);
    } finally {
      setSending(false);
    }
  };

  /**
   * Vendor and resident send. The panel's `onSend` owns the request and the
   * thread store, so nothing is added to a thread here: a refusal (false or a
   * throw) leaves every field, the attachments and the operation id as they
   * were, and Retry reuses the same `sendId`.
   */
  const submitScoped = async () => {
    if (!onSend) return;
    if (attachments.some((item) => item.uploading || item.error)) {
      setFormError("Wait for uploads to finish or remove failed attachments.");
      return;
    }
    if (recipientQuery.trim()) {
      setFormError("Choose a person from the list.");
      return;
    }
    setFormError(null);
    if (caps.channels.length > 0 && !viaInbox && !viaEmail) {
      fail("Choose In-app or Email.");
      return;
    }
    const s = subject.trim();
    const b = body.trim();
    if (!s || !b) {
      fail("Add a subject and message.");
      return;
    }
    if (selectedCategories.length === 0 || selectedKeys.length === 0) {
      fail("Choose a recipient.");
      return;
    }
    const targets = resolveEmailTargets();
    if (
      !targets.includesAxisAdmin &&
      targets.broadcastCategories.length === 0 &&
      targets.directEmails.length === 0
    ) {
      fail("Choose a recipient.");
      return;
    }
    const attachmentUrls = attachments.flatMap((item) => (item.uploadUrl ? [item.uploadUrl] : []));
    const deliverViaInbox = viaInbox || viaEmail;
    const fingerprint = JSON.stringify({
      subject: s,
      body: b,
      recipients: targets.directEmails.map((email) => email.toLowerCase()).sort(),
      broadcasts: [...targets.broadcastCategories].sort(),
      viaEmail,
      deliverViaInbox,
      attachmentUrls,
      propertyId: propertyContext?.propertyId ?? null,
      managerUserId: propertyContext?.managerUserId ?? null,
    });
    if (!sendOperationRef.current || sendOperationRef.current.fingerprint !== fingerprint) {
      sendOperationRef.current = { fingerprint, id: crypto.randomUUID() };
    }
    const payload: ScopedInboxSendPayload = {
      subject: s,
      body: b,
      senderName,
      senderEmail,
      toLabel: targets.labels.join(", "),
      toEmailLine: targets.directEmails.join("; "),
      directRecipientEmailLine: targets.directEmails.join("; "),
      directRecipientUserIds: targets.directRecipientUserIds,
      includesAxisAdmin: targets.includesAxisAdmin,
      includesDirectoryRecipients: targets.includesDirectoryRecipients,
      broadcastCategories: targets.broadcastCategories,
      scheduleLater: false,
      deliverViaEmail: viaEmail,
      deliverViaSms: false,
      deliverViaInbox,
      ...(attachmentUrls.length ? { attachmentUrls } : {}),
      propertyId: propertyContext?.propertyId,
      propertyTitle: propertyContext?.propertyTitle,
      managerUserId: propertyContext?.managerUserId,
      sendId: sendOperationRef.current.id,
    };
    setSending(true);
    try {
      const sent = await onSend(payload);
      if (sent !== false) sendOperationRef.current = null;
    } catch {
      // Keep the draft and the operation id so Retry is idempotent.
    } finally {
      setSending(false);
    }
  };

  const sendLabel = (() => {
    if (sending) return "Sending…";
    if (scheduleLater) return "Schedule";
    if (viaEmail && viaSms) return "Send message";
    if (viaSms) return "Send SMS";
    return viaEmail ? "Send email" : "Send message";
  })();

  return (
    <PortalDialog
      open={open}
      title="New message"
      previewLabel="Message preview"
      contextPanel={<PopupRecordPreview rows={[{ label: "Recipients", value: flatPersonOptions.filter(option => selectedKeys.includes(option.value as PersonKey)).map(option => option.label).join(", ") || "Not selected" }]} />}
      preview={<PopupMessagePreview subject={subject} body={body} recipient={flatPersonOptions.filter(option => selectedKeys.includes(option.value as PersonKey)).map(option => option.label).join(", ")} channel={sendLabel} sendAt={scheduleLater ? sendAt : undefined} />}
      secondaryAction={null}
      onClose={() => {
        sendOperationRef.current = null;
        onClose();
      }}
      primaryAction={{
        label: sendLabel,
        onClick: () => (isManager ? submit() : submitScoped()),
        disabled: sending || (!viaPortalDelivery && !viaSms),
        loading: sending,
        dataAttr: "communication-compose-send",
      }}
    >
      <PortalMessageComposeModalBody>
        {formError ? (
          <p
            role="alert"
            className="text-sm font-medium text-danger"
            data-attr="communication-compose-error"
          >
            {formError}
          </p>
        ) : null}
        <div className="relative" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setRecipientOpen(false); }}>
          <label className={portalMessageFieldLabel()} htmlFor="communication-compose-recipient">To</label>
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border px-3 py-2">
            {selectedKeys.map((key) => <button type="button" key={key} className="inline-flex items-center gap-1 text-sm" aria-label={`Remove ${recipientOptions.find((option) => option.key === key)?.label || key}`} onClick={() => {setSelectedKeys((previous) => previous.filter((value) => value !== key)); if (key === "admin") setSelectedCategories((previous) => previous.filter((category) => category !== "admin"));}}>
              {recipientOptions.find((option) => option.key === key)?.label || key}<X className="h-3 w-3" />
            </button>)}
            {otherTokens.map((token) => <button type="button" key={token.value} className="inline-flex items-center gap-1 text-sm" aria-label={`Remove ${token.label}`} onClick={() => {setOtherTokens((previous) => previous.filter((value) => value.value !== token.value)); if (otherTokens.length === 1) setSelectedCategories((previous) => previous.filter((category) => category !== "other"));}}>{token.label}<X className="h-3 w-3" /></button>)}
            <input id="communication-compose-recipient" role="combobox" aria-expanded={recipientOpen} aria-controls="communication-compose-recipient-options" aria-autocomplete="list" value={recipientQuery} placeholder={caps.otherRecipients ? "Name, email or phone number" : "Name"} className="min-w-32 flex-1 bg-transparent py-2 text-sm outline-none" onFocus={() => setRecipientOpen(true)} onChange={(event) => {setRecipientQuery(event.target.value); setRecipientOpen(true);}} onKeyDown={(event) => {
              if (event.key === "Escape") setRecipientOpen(false);
              if (event.key !== "Enter" && event.key !== ",") return;
              event.preventDefault();
              if (!caps.otherRecipients) {
                // Vendor and resident pick people from their own list; nothing typed becomes an address.
                const first = recipientOptions.find((option) => !selectedKeys.includes(option.key) && option.label.toLowerCase().includes(recipientQuery.toLowerCase()));
                if (!first || !recipientQuery.trim()) {setFormError("Choose a person from the list."); return;}
                setSelectedCategories((previous) => previous.includes(first.category) ? previous : [...previous, first.category]);
                setSelectedKeys((previous) => [...previous, first.key]); setRecipientQuery(""); setRecipientOpen(false); setFormError(null);
                return;
              }
              const token = commitOtherRecipientToken(recipientQuery);
              if (!token) {setFormError("Choose a contact or enter a valid email or phone number."); return;}
              setSelectedCategories((previous) => previous.includes("other") ? previous : [...previous, "other"]);
              setOtherTokens((previous) => previous.some((item) => item.value === token.value) ? previous : [...previous, token]);
              setRecipientQuery(""); setRecipientOpen(false); setFormError(null);
            }} data-attr="communication-compose-recipient" />
          </div>
          {recipientOpen ? <div className="absolute inset-x-0 top-full z-20 mt-1 max-h-60 overflow-y-auto rounded-xl border border-border bg-card p-1 shadow-lg" id="communication-compose-recipient-options" role="listbox" aria-label="Recipients">
            {recipientOptions.filter((option) => !selectedKeys.includes(option.key) && option.label.toLowerCase().includes(recipientQuery.toLowerCase())).map((option) => <button key={option.key} type="button" role="option" aria-selected={false} className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-accent" onClick={() => {
              setSelectedCategories((previous) => previous.includes(option.category) ? previous : [...previous, option.category]);
              setSelectedKeys((previous) => [...previous, option.key]); setRecipientQuery(""); setRecipientOpen(false);
            }}>{option.label}</button>)}
          </div> : null}
        </div>
        <PortalMessageSubjectField value={subject} onChange={setSubject} dataAttr="communication-compose-subject" />

        <PortalMessageBodyField
          value={body}
          onChange={setBody}
          placeholder="Write your message…"
          minHeightClass="min-h-[7rem]"
          maxLength={viaSms ? 1600 : undefined}
          showCharCount={viaSms}
          dataAttr="communication-compose-body"
        />

        {attachments.length ? <div className="flex flex-wrap gap-2">{attachments.map((item) => <span key={item.id} className="inline-flex items-center gap-2 rounded-lg border border-border px-2 py-1 text-sm" title={item.error}>
          <Paperclip className="h-3 w-3" />{item.fileName}{item.uploading ? " · Uploading…" : item.error ? " · Failed" : ""}
          <button type="button" aria-label={`Remove ${item.fileName}`} onClick={() => {revokeInboxAttachmentPreview(item); setAttachments((previous) => previous.filter((value) => value.id !== item.id));}}><X className="h-3 w-3" /></button>
        </span>)}</div> : null}
        {viaSms && attestationVendors.length > 0 ? (
          <div className="space-y-1.5" data-attr="communication-compose-vendor-attest">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={attestVendor}
                onChange={(event) => setAttestVendor(event.target.checked)}
                data-attr="communication-compose-vendor-attest-checkbox"
              />
              <span>I work with this vendor</span>
            </label>
            {attestationSenderLine ? (
              <p className="text-xs text-muted" data-attr="communication-compose-vendor-sender-line">
                Sent as: &ldquo;{body.trim() ? `${body.trim().length > 40 ? `${body.trim().slice(0, 40).trimEnd()}…` : body.trim()} ` : "… "}
                {attestationSenderLine}&rdquo;
              </p>
            ) : null}
          </div>
        ) : null}
        {viaSms && otherTokens.some((token) => token.kind === "phone") ? (
          <label className="flex items-center gap-2 text-sm" data-attr="communication-compose-is-vendor">
            <input type="checkbox" checked={markVendor} onChange={(event) => setMarkVendor(event.target.checked)} />
            <span>This is a vendor</span>
          </label>
        ) : null}
        <div className="flex items-center gap-2" data-attr="communication-compose-tools">
          {caps.attach ? <label className="grid h-10 w-10 cursor-pointer place-items-center rounded-full text-muted hover:bg-accent" title="Attach files">
            <Paperclip className="h-4 w-4" aria-hidden /><input type="file" aria-label="Attach files" className="sr-only" accept={INBOX_ATTACHMENT_ACCEPT} multiple disabled={sending || attachments.length >= INBOX_MAX_ATTACHMENTS} onChange={(event) => {pickAttachments(event.target.files); event.target.value = "";}} data-attr="communication-compose-attach" />
          </label> : null}
          {caps.draft ? <button type="button" aria-label="Draft with PropLane" title="Draft with PropLane" disabled={drafting || sending} className="grid h-10 w-10 place-items-center rounded-full text-primary disabled:opacity-40" onClick={() => draftMessage()} data-attr="communication-compose-draft"><Sparkles className="h-4 w-4" /></button> : null}
          {caps.schedule ? <InboxComposerScheduleMenu scheduleLater={scheduleLater} onScheduleLaterChange={setScheduleLater} sendAt={sendAt} onSendAtChange={setSendAt} scheduleDataAttr="communication-compose-schedule-later" sendAtDataAttr="communication-compose-schedule-at" /> : null}
          {[{ id: "proplane", label: "In-app", icon: MessageSquare }, { id: "email", label: "Email", icon: Mail }, { id: "sms", label: "Text message", icon: Smartphone }].filter(({ id }) => caps.channels.includes(id as "proplane" | "email" | "sms")).map(({id, label, icon: Icon}) => <button type="button" key={id} title={label} aria-label={label} aria-pressed={sendVia.includes(id)} className={`grid h-10 w-10 place-items-center rounded-full ${sendVia.includes(id) ? "bg-primary/10 text-primary" : "text-muted"}`} onClick={() => setSendVia((previous) => previous.includes(id) ? previous.filter((value) => value !== id) : [...previous, id])}><Icon className="h-4 w-4" /></button>)}
        </div>
      </PortalMessageComposeModalBody>
    </PortalDialog>
  );
}
