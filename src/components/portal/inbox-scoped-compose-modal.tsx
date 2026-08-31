"use client";

import { useEffect, useMemo, useState } from "react";
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
} from "@/components/portal/portal-message-compose-fields";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { DEMO_INBOX_COMPOSE_PREFILL_EVENT } from "@/lib/demo/demo-playback";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { mergeInboxScopedContacts } from "@/lib/manager-inbox-contacts";
import {
  composeDirectoryCategories,
  composeValidPersonKeys,
  isAdminOnlyDirectorySelection,
  mergeAdminComposePersonKey,
  type InboxComposeDirectoryCategory,
} from "@/lib/inbox-compose-recipients";
import {
  broadcastStubForCategory,
  categoryForContactRole,
  contactsForPortal,
  PRIMARY_AXIS_ADMIN_LABEL,
  type InboxRecipientCategory,
  type InboxScopedContact,
} from "@/data/inbox-scoped-directory";
import type { ResidentComposePrefill } from "@/lib/resident-compose-prefill";

export type ScopedInboxSendPayload = {
  subject: string;
  body: string;
  senderName: string;
  senderEmail: string;
  toLabel: string;
  toEmailLine: string;
  /** Same as toEmailLine but with "All management"/"All residents" placeholder addresses stripped. */
  directRecipientEmailLine: string;
  includesAxisAdmin: boolean;
  includesDirectoryRecipients: boolean;
  /** Broadcast categories selected ("All management" / "All residents"), resolved to real recipients server-side. */
  broadcastCategories: ("management" | "resident")[];
  scheduleLater?: boolean;
  sendAt?: string;
  /** Delivery channels for manager portal compose. */
  deliverViaEmail?: boolean;
  deliverViaSms?: boolean;
  /** Property-scoped resident → manager thread (tour, listing, charge). */
  propertyId?: string;
  propertyTitle?: string;
  managerUserId?: string;
};

type ComposeCategory = InboxComposeDirectoryCategory;
type PersonKey = "admin" | "broadcast:management" | "broadcast:resident" | `id:${string}`;

function contactOptionLabel(contact: InboxScopedContact): string {
  const property = contact.propertyLabel?.trim();
  const status =
    contact.role === "resident"
      ? contact.tenancyStatus === "applicant"
        ? "Applicant"
        : "Resident"
      : null;
  const bits = [contact.name, status, property || contact.email].filter(Boolean);
  return bits.join(" · ");
}

function categoriesForPortal(
  portal: "resident" | "manager" | "vendor",
  contacts: InboxScopedContact[],
): ComposeCategory[] {
  return composeDirectoryCategories(portal, contacts);
}

function categoryLabel(category: ComposeCategory): string {
  if (category === "resident") return "Residents & applicants";
  if (category === "management") return "Manager";
  if (category === "vendor") return "Vendor";
  return "PropLane admin";
}

function peopleForCategory(
  category: ComposeCategory,
  portal: "resident" | "manager" | "vendor",
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

  const roleCategory: InboxRecipientCategory = category === "resident" ? "resident" : "management";
  const people = contacts
    .filter((c) => categoryForContactRole(portal, c.role) === roleCategory)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    .map((c) => ({ key: `id:${c.id}` as const, label: contactOptionLabel(c) }));

  if (portal === "manager" && category === "resident") {
    return [{ key: "broadcast:resident", label: "All residents" }, ...people];
  }
  if (portal === "manager" && category === "management") {
    return [{ key: "broadcast:management", label: "All management" }, ...people];
  }
  return people;
}

/**
 * New message compose: two multi-select dropdowns (sections + people) with checkboxes.
 */

/**
 * A default parameter of `[]` is a NEW array every render, which re-runs every
 * memo and effect keyed on it. Paired with the pruning effects below that is an
 * infinite update loop. One module-level empty keeps the identity stable.
 */
const NO_LIVE_CONTACTS: InboxScopedContact[] = [];

export function ScopedInboxComposeModal({
  open,
  onClose,
  onSend,
  portal,
  title = "New message",
  senderName = "Portal user",
  senderEmail = "portal-user@example.com",
  liveContacts = NO_LIVE_CONTACTS,
  initialDraft = null,
  initialScheduleLater = false,
}: {
  open: boolean;
  onClose: () => void;
  onSend: (payload: ScopedInboxSendPayload) => void;
  portal: "resident" | "manager" | "vendor";
  title?: string;
  senderName?: string;
  senderEmail?: string;
  liveContacts?: InboxScopedContact[];
  initialDraft?: ResidentComposePrefill | null;
  /** When true, opens with "Schedule for later" checked (resident thread schedule flow). */
  initialScheduleLater?: boolean;
}) {
  const { showToast } = useAppUi();
  const localContacts = useMemo(() => contactsForPortal(portal, liveContacts), [portal, liveContacts]);
  const [directoryContacts, setDirectoryContacts] = useState<InboxScopedContact[]>([]);
  const contacts = directoryContacts.length > 0 ? directoryContacts : localContacts;
  const categoryOptions = useMemo(() => categoriesForPortal(portal, contacts), [portal, contacts]);
  const [selectedCategories, setSelectedCategories] = useState<ComposeCategory[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<PersonKey[]>([]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sendVia, setSendVia] = useState<string[]>(["email"]);
  const [scheduleLater, setScheduleLater] = useState(false);
  const [sendAt, setSendAt] = useState(defaultPortalMessageScheduleAt);
  const [propertyContext, setPropertyContext] = useState<{
    propertyId?: string;
    propertyTitle?: string;
    managerUserId?: string;
  } | null>(null);

  const { viaEmail, viaSms } = portalMessageChannelsFromSelection(sendVia);

  const sectionOptions = useMemo(
    () => categoryOptions.map((c) => ({ value: c, label: categoryLabel(c) })),
    [categoryOptions],
  );

  const personGroups = useMemo((): CheckboxMultiSelectGroup[] => {
    const cats = selectedCategories.length > 0 ? selectedCategories : [];
    return cats
      .map((category) => ({
        label: categoryLabel(category),
        options: peopleForCategory(category, portal, contacts).map((p) => ({
          value: p.key,
          label: p.label,
        })),
      }))
      .filter((g) => g.options.length > 0);
  }, [selectedCategories, portal, contacts]);

  const flatPersonOptions = useMemo(() => personGroups.flatMap((g) => g.options), [personGroups]);
  const validPersonKeys = useMemo(
    () => composeValidPersonKeys(flatPersonOptions.map((o) => o.value), selectedCategories),
    [flatPersonOptions, selectedCategories],
  );
  const adminOnlyDirectory = isAdminOnlyDirectorySelection(selectedCategories);

  const showSmsOption = portal === "manager";

  useEffect(() => {
    if (!open || portal !== "manager" || isDemoModeActive()) {
      if (open && portal === "manager" && isDemoModeActive()) setDirectoryContacts(localContacts);
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
  }, [open, portal, localContacts]);

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
          setSelectedCategories(["resident"]);
          setSelectedKeys([`id:${hit.id}`]);
        }
      }
    };
    window.addEventListener(DEMO_INBOX_COMPOSE_PREFILL_EVENT, onPrefill as EventListener);
    return () => window.removeEventListener(DEMO_INBOX_COMPOSE_PREFILL_EVENT, onPrefill as EventListener);
  }, [contacts]);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      const draft = initialDraft;
      if (draft) {
        setSubject(draft.subject?.trim() || "");
        setBody(draft.body?.trim() || "");
        setPropertyContext({
          propertyId: draft.propertyId?.trim() || undefined,
          propertyTitle: draft.propertyTitle?.trim() || undefined,
          managerUserId: draft.managerUserId?.trim() || undefined,
        });
      } else {
        setSubject("");
        setBody("");
        setPropertyContext(null);
        setSelectedCategories([]);
        setSelectedKeys([]);
      }
      setSendVia(defaultPortalMessageChannelSelection(true, showSmsOption, true, false));
      setScheduleLater(initialScheduleLater);
      setSendAt(defaultPortalMessageScheduleAt());
    });
  }, [open, portal, initialDraft, initialScheduleLater, showSmsOption]);

  useEffect(() => {
    if (!open || !initialDraft || contacts.length === 0) return;
    const email = initialDraft.recipientEmail?.trim().toLowerCase();
    const managerId = initialDraft.managerUserId?.trim();
    const hit =
      (managerId
        ? contacts.find((c) => c.id === `mgr-${managerId}` || c.id === managerId)
        : undefined) ??
      (email ? contacts.find((c) => c.email.trim().toLowerCase() === email) : undefined);
    if (!hit) return;
    const category =
      hit.role === "manager" ? "management" : hit.role === "vendor" ? "vendor" : "resident";
    setSelectedCategories([category]);
    setSelectedKeys([`id:${hit.id}` as PersonKey]);
  }, [open, initialDraft, contacts]);

  // Return `prev` when nothing was pruned. `filter` always allocates, and
  // setting a fresh array unconditionally re-renders, which re-runs the effect
  // whenever its dependency is not identity-stable — an infinite loop.
  useEffect(() => {
    setSelectedCategories((prev) => {
      const next = prev.filter((c) => categoryOptions.includes(c));
      return next.length === prev.length ? prev : next;
    });
  }, [categoryOptions]);

  useEffect(() => {
    setSelectedKeys((prev) => {
      const next = mergeAdminComposePersonKey(selectedCategories, prev);
      return next.length === prev.length && next.every((k, i) => k === prev[i]) ? prev : next;
    });
  }, [selectedCategories]);

  useEffect(() => {
    setSelectedKeys((prev) => {
      const next = prev.filter((key) => validPersonKeys.has(key));
      return next.length === prev.length ? prev : next;
    });
  }, [validPersonKeys]);

  const onCategoriesChange = (next: string[]) => {
    const cats = next.filter((v): v is ComposeCategory =>
      categoryOptions.includes(v as ComposeCategory),
    );
    setSelectedCategories(cats);
    setSelectedKeys((prev) => mergeAdminComposePersonKey(cats, prev));
  };

  const onPeopleChange = (next: string[]) => {
    setSelectedKeys(next as PersonKey[]);
  };

  const submit = () => {
    const s = subject.trim();
    const b = body.trim();
    if (!s || !b) {
      showToast("Add a subject and message.");
      return;
    }
    if (selectedCategories.length === 0) {
      showToast("Select at least one section (Resident, Manager, …).");
      return;
    }
    if (selectedKeys.length === 0) {
      showToast("Select at least one recipient.");
      return;
    }
    if (!viaEmail && !viaSms) {
      showToast("Choose at least one channel under Send via.");
      return;
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
    }

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

    if (!includesAxisAdmin && broadcastCategories.length === 0 && directEmails.length === 0) {
      showToast("Select at least one recipient.");
      return;
    }

    onSend({
      subject: s,
      body: b,
      senderName,
      senderEmail,
      toLabel: labels.join(", "),
      toEmailLine: directEmails.join("; "),
      directRecipientEmailLine: directEmails.join("; "),
      includesAxisAdmin,
      includesDirectoryRecipients,
      broadcastCategories,
      scheduleLater,
      sendAt: scheduleLater ? new Date(sendAt).toISOString() : undefined,
      deliverViaEmail: viaEmail,
      deliverViaSms: showSmsOption ? viaSms : false,
      propertyId: propertyContext?.propertyId,
      propertyTitle: propertyContext?.propertyTitle,
      managerUserId: propertyContext?.managerUserId,
    });
  };

  const sendLabel = scheduleLater ? "Schedule" : viaEmail && viaSms ? "Send message" : viaSms ? "Send SMS" : "Send email";

  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      dense
      assistantStrip={portal !== "resident"}
      panelClassName={PORTAL_MESSAGE_COMPOSE_MODAL_PANEL_CLASS}
      footer={
        <ModalFooter>
          <Button type="button" variant="primary" className="rounded-full" data-attr="inbox-compose-send" onClick={submit}>
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
          sectionDataAttr="inbox-compose-category"
          personGroups={personGroups}
          selectedKeys={selectedKeys}
          onPeopleChange={onPeopleChange}
          peopleDisabled={selectedCategories.length === 0 || adminOnlyDirectory}
          peopleEmptyMenuText={
            selectedCategories.length === 0
              ? "Pick a section first"
              : adminOnlyDirectory
                ? "PropLane admin is the recipient"
                : "No contacts in selected sections"
          }
        />

        <div className={PORTAL_MESSAGE_COMPOSE_TWO_COL_CLASS}>
          <PortalMessageSubjectField value={subject} onChange={setSubject} />

          <PortalMessageSendViaDropdown
            selected={sendVia}
            onChange={setSendVia}
            emailAvailable
            smsAvailable={showSmsOption}
            dataAttr="inbox-compose-send-via"
          />
        </div>

        <PortalMessageBodyField value={body} onChange={setBody} minHeightClass="min-h-[7rem]" />

        <PortalMessageScheduleFields
          scheduleLater={scheduleLater}
          onScheduleLaterChange={setScheduleLater}
          sendAt={sendAt}
          onSendAtChange={setSendAt}
        />
      </PortalMessageComposeModalBody>
    </Modal>
  );
}
