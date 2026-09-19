"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommunicationStatusFilterDraft, type CommunicationStatus } from "@/components/portal/communication-status-filter";

import { CommunicationRowActions } from "@/components/portal/communication-row-actions";
import { PortalFilterSortSheet } from "@/components/portal/portal-filter-sort-sheet";
import { useUnifiedCommunicationBulk } from "@/hooks/use-unified-communication-bulk";
import { Button } from "@/components/ui/button";
import { CommunicationInboxInitialState } from "@/components/portal/communication-inbox-initial-state";
import { ResidentInboxPanel, type ResidentInboxPanelHandle } from "@/components/portal/resident-inbox-panel";
import { ResidentManagerNumberCard } from "@/components/portal/resident-manager-number-card";
import {
  INBOX_LIST_SCROLL,
  InboxConversationRow,
  InboxThreadView,
  InboxTwoPane,
  PORTAL_INBOX_LIST_TOOLBAR_CLASS,
  PortalInboxEmptyState,
  type InboxListSegment,
  type InboxBubbleMessage,
} from "@/components/portal/portal-inbox-ui";
import { PortalCommunicationShell } from "@/components/portal/portal-communication-shell";
import { PORTAL_HEADER_PRIMARY_ACTION_BTN } from "@/components/portal/portal-metrics";
import { canonicalResidentAgentThreadId } from "@/lib/agent/resident-inbox-agent-ids";
import {
  mergeUnifiedInboxItems,
  parseUnifiedInboxKey,
  unifiedInboxKey,
  type UnifiedInboxListItem,
} from "@/lib/unified-inbox-merge";
import {
  PORTAL_INBOX_CHANGED_EVENT,
  RESIDENT_INBOX_STORAGE_KEY,
  inboxIdentitiesCompatible,
  inboxIdentityProvenance,
  inboxThreadMessages,
  inboxThreadSortMs,
  loadPersistedInbox,
  markPersistedInboxSourcesRead,
  syncPersistedInboxFromServerWithStatus,
  stagePersistedInboxRows,
} from "@/lib/portal-inbox-storage";
import { isPropLaneAssistantInboxThread } from "@/lib/communication-inbox-assistant";
import { filterEmailInboxThreads } from "@/lib/communication-inbox-filters";
import {
  buildResidentAssistantPlaceholderThread,
  communicationInboxListPreview,
  pinPropLaneAssistantUnifiedItems,
  propLaneAssistantListPreview,
  propLaneAssistantListSubtitle,
  propLaneAssistantThreadIdForPortal,
  resolveCommunicationViewerId,
  withPinnedPropLaneAssistantThreads,
} from "@/lib/communication-assistant-inbox-list";
import { usePortalSession } from "@/hooks/use-portal-session";
import { observeCommunicationInitialViewer, retryStaleCommunicationSource } from "@/lib/communication-initial-load";
import { useResidentManagerContacts } from "@/hooks/use-resident-manager-contacts";
import {
  inboxRowAddressLabel,
  inboxThreadCategoryLabel,
  inboxThreadUnreadCount,
} from "@/lib/communication-row-meta";
import { inboxThreadLastTurnDirection } from "@/lib/inbox-turn-direction";
import {
  clearCommunicationThreadUrl,
  selectCommunicationThreadUrl,
} from "@/lib/portal-communication-nav";
import { useCommunicationThreadId } from "@/hooks/use-communication-thread-id";
import { RESIDENT_PORTAL_BASE_PATH } from "@/lib/portals/resident-sections";
import {
  normalizeRoleSmsPayload,
  smsMessageBucket,
  type ManagerSmsMessageRow,
  type RoleSmsManagerConversation,
} from "@/lib/manager-sms-messages";
import { formatPacificDate, formatPacificDateTime } from "@/lib/pacific-time";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";

const SMS_THREAD_ID = "text-messages";
const SMS_OPENED_KEY = "axis_role_sms_opened_resident";
const SMS_ARCHIVED_KEY_PREFIX = "axis_role_sms_archived_resident";

type UnreadSelectionAdmission = {
  viewerId: string | null;
  listSegment: InboxListSegment;
  readOnly: boolean;
  includeArchived: boolean;
  query: string;
  memberKeys: Set<string>;
};

function unifiedMemberKeys(row: UnifiedInboxListItem): Set<string> {
  return new Set([row.key, ...(row.memberKeys ?? [])]);
}

function hasExactUnifiedMemberContinuity(
  row: UnifiedInboxListItem,
  admittedMemberKeys: ReadonlySet<string>,
): boolean {
  const currentMemberKeys = unifiedMemberKeys(row);
  return currentMemberKeys.size === admittedMemberKeys.size &&
    [...currentMemberKeys].every((key) => admittedMemberKeys.has(key));
}

function loadOpenedIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(SMS_OPENED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

function persistOpenedIds(ids: ReadonlySet<string>): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SMS_OPENED_KEY, JSON.stringify([...ids]));
}

function residentSmsArchiveKey(viewerId: string | null): string {
  return `${SMS_ARCHIVED_KEY_PREFIX}:${viewerId ?? "anon"}`;
}

function loadArchivedSmsIds(viewerId: string | null): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(residentSmsArchiveKey(viewerId)) ?? "[]") as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && Boolean(id.trim())) : []);
  } catch {
    return new Set();
  }
}

function ResidentSmsTimeline({
  messages,
  title,
  onBack,
  threadKey,
}: {
  messages: ManagerSmsMessageRow[];
  title: string;
  onBack: () => void;
  threadKey: string;
}) {
  const bubbles = useMemo((): InboxBubbleMessage[] => [...messages]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((message) => ({
      id: `sms:${message.id}`,
      author: message.direction === "outbound" ? "Resident" : title,
      body: message.body,
      at: formatPacificDateTime(message.createdAt),
      direction: message.direction,
      channel: "sms" as const,
    })), [messages, title]);

  return (
    <InboxThreadView
      title={title}
      avatarName={title}
      subtitle="Text messages"
      messages={bubbles}
      showAuthors
      onBack={onBack}
      threadKey={threadKey}
      emptyLabel="No text messages in this conversation."
    />
  );
}

function declaredSmsBindingKeys(thread: PersistedInboxThread): string[] {
  return [...new Set([
    ...(thread.smsBindingKeys ?? []),
    thread.smsConversationKey ?? "",
    ...inboxIdentityProvenance(thread).map((identity) => identity.smsConversationKey ?? ""),
  ].map((key) => key.trim()).filter(Boolean))];
}

function conversationMatchesStoredManagerEvidence(
  thread: PersistedInboxThread,
  conversation: RoleSmsManagerConversation,
): boolean {
  const claims = inboxIdentityProvenance(thread);
  if (claims.some((claim, index) => claims.slice(index + 1).some((other) => !inboxIdentitiesCompatible(claim, other)))) {
    return false;
  }
  const managerId = thread.managerUserId?.trim();
  const propertyId = thread.propertyId?.trim();
  const email = thread.email.trim().toLowerCase();
  return Boolean(
    managerId && propertyId && email &&
    conversation.managerUserId === managerId &&
    conversation.propertyId?.trim() === propertyId &&
    conversation.managerEmail.trim().toLowerCase() === email,
  );
}

function hasConflictingStoredManagerEvidence(
  thread: PersistedInboxThread,
  conversation: RoleSmsManagerConversation,
): boolean {
  const claims = inboxIdentityProvenance(thread);
  if (claims.some((claim, index) => claims.slice(index + 1).some((other) => !inboxIdentitiesCompatible(claim, other)))) {
    return true;
  }
  const managerId = thread.managerUserId?.trim();
  const propertyId = thread.propertyId?.trim();
  const email = thread.email.trim().toLowerCase();
  const candidateManagerId = conversation.managerUserId.trim();
  const candidatePropertyId = conversation.propertyId?.trim() ?? "";
  const candidateEmail = conversation.managerEmail.trim().toLowerCase();
  const overlaps =
    (managerId && managerId === candidateManagerId) ||
    (propertyId && propertyId === candidatePropertyId) ||
    (email && email === candidateEmail);
  return Boolean(overlaps && (
    (managerId && managerId !== candidateManagerId) ||
    (propertyId && propertyId !== candidatePropertyId) ||
    (email && email !== candidateEmail)
  ));
}

function hasContradictoryStoredManagerEvidence(
  thread: PersistedInboxThread,
  conversation: RoleSmsManagerConversation,
): boolean {
  const candidateManagerId = conversation.managerUserId.trim();
  const candidatePropertyId = conversation.propertyId?.trim() ?? "";
  const candidateEmail = conversation.managerEmail.trim().toLowerCase();
  const claims = inboxIdentityProvenance(thread);
  return claims.some((claim) => {
    const managerId = claim.managerUserId?.trim();
    const propertyId = claim.propertyId?.trim();
    return Boolean(
      (managerId && managerId !== candidateManagerId) ||
      (propertyId && propertyId !== candidatePropertyId),
    );
  }) || Boolean(thread.email.trim() && thread.email.trim().toLowerCase() !== candidateEmail);
}

function propagateProvenManagerEvidence(rows: PersistedInboxThread[]): PersistedInboxThread[] {
  const groups = new Map<string, PersistedInboxThread[]>();
  for (const row of rows) {
    if (isPropLaneAssistantInboxThread(row)) continue;
    const email = row.email.trim().toLowerCase();
    if (!email.includes("@")) continue;
    const group = groups.get(email) ?? [];
    group.push(row);
    groups.set(email, group);
  }
  const evidence = new Map<string, { managerUserId: string; propertyId: string; bindingKey?: string }>();
  for (const [email, group] of groups) {
    const claims = group.flatMap(inboxIdentityProvenance);
    const managerIds = [...new Set(claims.map((claim) => claim.managerUserId?.trim() ?? "").filter(Boolean))];
    const propertyIds = [...new Set(claims.map((claim) => claim.propertyId?.trim() ?? "").filter(Boolean))];
    const bindingKeys = [...new Set(group.flatMap(declaredSmsBindingKeys))];
    if (managerIds.length !== 1 || propertyIds.length !== 1 || bindingKeys.length > 1) continue;
    evidence.set(email, {
      managerUserId: managerIds[0]!,
      propertyId: propertyIds[0]!,
      ...(bindingKeys.length === 1 ? { bindingKey: bindingKeys[0] } : {}),
    });
  }
  return rows.map((row) => {
    if (isPropLaneAssistantInboxThread(row)) return row;
    const proven = evidence.get(row.email.trim().toLowerCase());
    if (!proven) return row;
    // A same-email row with no manager/property evidence is still unknown.
    // Do not let a different relationship lend it an identity merely because
    // SMS is enabled (or because another historical row is richer).
    const ownClaims = inboxIdentityProvenance(row);
    const hasManagerEvidence = Boolean(
      row.managerUserId?.trim() || ownClaims.some((claim) => claim.managerUserId?.trim()),
    );
    const hasPropertyEvidence = Boolean(
      row.propertyId?.trim() || ownClaims.some((claim) => claim.propertyId?.trim()),
    );
    if (!hasManagerEvidence || !hasPropertyEvidence) return row;
    const ownBindings = declaredSmsBindingKeys(row);
    return {
      ...row,
      managerUserId: row.managerUserId?.trim() || proven.managerUserId,
      propertyId: row.propertyId?.trim() || proven.propertyId,
      ...(ownBindings.length === 0 && proven.bindingKey
        ? { smsConversationKey: proven.bindingKey, smsBindingKeys: [proven.bindingKey] }
        : {}),
    };
  });
}

function residentRelationshipPersonKey(
  thread: PersistedInboxThread,
  verifiedManager: RoleSmsManagerConversation | null,
): string | undefined {
  const claims = inboxIdentityProvenance(thread);
  if (claims.some((claim, index) => claims.slice(index + 1).some((other) => !inboxIdentitiesCompatible(claim, other)))) {
    return undefined;
  }
  const managerIds = [...new Set(claims.map((claim) => claim.managerUserId?.trim() ?? "").filter(Boolean))];
  const propertyIds = [...new Set(claims.map((claim) => claim.propertyId?.trim() ?? "").filter(Boolean))];
  const bindingKeys = declaredSmsBindingKeys(thread);
  if (managerIds.length > 1 || propertyIds.length > 1 || bindingKeys.length > 1) return undefined;

  const managerId = managerIds[0] ?? verifiedManager?.managerUserId.trim();
  const propertyId = propertyIds[0] ?? verifiedManager?.propertyId?.trim();
  const bindingKey = bindingKeys[0] ?? verifiedManager?.conversationKey.trim();
  // Email alone is not a relationship identity. Unknown rows stay isolated so
  // a later property or manager record cannot bridge them accidentally.
  const email = thread.email.trim().toLowerCase();
  return residentManagerRelationshipKey(email, managerId, propertyId, bindingKey);
}

function residentManagerRelationshipKey(
  email: string | null | undefined,
  managerId: string | null | undefined,
  propertyId: string | null | undefined,
  bindingKey: string | null | undefined,
): string | undefined {
  const normalizedEmail = email?.trim().toLowerCase() ?? "";
  const normalizedManagerId = managerId?.trim() ?? "";
  const normalizedPropertyId = propertyId?.trim() ?? "";
  if (!normalizedEmail.includes("@") || !normalizedManagerId || !normalizedPropertyId) return undefined;
  return [normalizedEmail, normalizedManagerId, normalizedPropertyId, bindingKey?.trim() || "unbound"]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

function inboxUsesDesktopSplit(): boolean {
  if (typeof window === "undefined") return true;
  if (typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(min-width: 1024px)").matches;
}

function ResidentUnifiedInbox({
  inboxRef,
  smsUiEnabled,
  listSegment,
  readOnly = false,
  includeArchived = false,
  routeThreadId,
  onRouteThreadChange,
  onThreadOpenChange,
  onThreadSelectedChange,
  commBase,
  onAddConversation,
  residentUserId,
}: {
  inboxRef: React.RefObject<ResidentInboxPanelHandle | null>;
  smsUiEnabled: boolean;
  listSegment: InboxListSegment;
  readOnly?: boolean;
  /** "All conversations": archived rows stay in the active list. */
  includeArchived?: boolean;
  routeThreadId?: string;
  onRouteThreadChange?: (threadId: string | undefined) => void;
  onThreadOpenChange?: (open: boolean) => void;
  onThreadSelectedChange?: (selected: boolean) => void;
  commBase: string;
  onAddConversation?: () => void;
  residentUserId?: string | null;
}) {
  const { userId, ready: sessionReady } = usePortalSession({ userId: residentUserId ?? null });
  const viewerId = resolveCommunicationViewerId(residentUserId, userId);
  const viewerEpochRef = useRef(0);
  useEffect(() => {
    viewerEpochRef.current += 1;
  }, [viewerId]);
  // The resident has ONE house, so every row carries the same street line. The
  // lookup is shared with the contact card above the list, not re-fetched.
  const managerContacts = useResidentManagerContacts();
  const homeAddress = useMemo(
    () => inboxRowAddressLabel(managerContacts.find((c) => c.propertyLabel)?.propertyLabel),
    [managerContacts],
  );
  // Inbox rows hydrate from sessionStorage — never read them in useState initializers (SSR mismatch).
  const [emailThreads, setEmailThreads] = useState<PersistedInboxThread[]>([]);
  const [smsMessages, setSmsMessages] = useState<ManagerSmsMessageRow[]>([]);
  const [smsConversations, setSmsConversations] = useState<RoleSmsManagerConversation[]>([]);
  const [smsOpened, setSmsOpened] = useState<Set<string>>(() => new Set());
  const [smsArchived, setSmsArchived] = useState<Set<string>>(() => new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [unreadSelectionAdmission, setUnreadSelectionAdmission] = useState<UnreadSelectionAdmission | null>(null);
  const resolvedRouteRef = useRef<{ threadId: string; viewerId: string | null } | null>(null);
  const [initialListState, setInitialListState] = useState<"loading" | "ready" | "error">("loading");
  const [initialListViewerId, setInitialListViewerId] = useState<string | null>(null);
  const initialLoadGeneration = useRef(0);
  const initialViewerCleanupRef = useRef<(() => void) | null>(null);
  const readInFlightRef = useRef(new Map<string, object>());
  const readSucceededRef = useRef(new Set<string>());
  const readAttemptsRef = useRef(new Map<string, number>());
  const selectedKeyRef = useRef<string | null>(selectedKey);
  const viewerIdRef = useRef(viewerId);
  const initialListReady = initialListState === "ready" && initialListViewerId === viewerId;
  const assistantThreadId = viewerId ? propLaneAssistantThreadIdForPortal("resident", viewerId) : null;

  useEffect(() => {
    selectedKeyRef.current = selectedKey;
  }, [selectedKey]);

  useEffect(() => {
    viewerIdRef.current = viewerId;
  }, [viewerId]);

  useEffect(() => {
    const syncEmail = () => setEmailThreads(loadPersistedInbox(RESIDENT_INBOX_STORAGE_KEY, []));
    syncEmail();
    setSmsOpened(loadOpenedIds());
    window.addEventListener(PORTAL_INBOX_CHANGED_EVENT, syncEmail as EventListener);
    return () => window.removeEventListener(PORTAL_INBOX_CHANGED_EVENT, syncEmail as EventListener);
  }, []);

  useEffect(() => {
    setSmsArchived(loadArchivedSmsIds(viewerId));
    // Attempts and receipts belong to a viewer. Drop the old viewer's state
    // so a delayed response cannot suppress a fresh viewer's acknowledgement.
    readInFlightRef.current.clear();
    readSucceededRef.current.clear();
    readAttemptsRef.current.clear();
  }, [viewerId]);

  useEffect(() => {
    if (!viewerId?.trim() || listSegment !== "active") return;
    let staged: PersistedInboxThread[] | null = null;
    setEmailThreads((current) => {
      const hasAssistant = current.some(
        (thread) =>
          isPropLaneAssistantInboxThread(thread) ||
          thread.id === canonicalResidentAgentThreadId(viewerId),
      );
      if (hasAssistant) return current;
      const next = [buildResidentAssistantPlaceholderThread(viewerId), ...current];
      staged = next;
      return next;
    });
    if (staged) {
      queueMicrotask(() => stagePersistedInboxRows(RESIDENT_INBOX_STORAGE_KEY, staged!));
    }
  }, [listSegment, viewerId]);

  const loadResidentSms = useCallback(async (requestGeneration?: number): Promise<boolean> => {
    const requestViewerEpoch = viewerEpochRef.current;
    if (!smsUiEnabled) return true;
    try {
      const res = await fetch("/api/resident/sms-conversations", { credentials: "include", cache: "no-store" });
      if (!res.ok) return false;
      const body = (await res.json()) as {
        messages?: ManagerSmsMessageRow[];
        conversations?: RoleSmsManagerConversation[];
      };
      if (!body || !Array.isArray(body.messages)) return false;
      if (
        viewerEpochRef.current !== requestViewerEpoch ||
        (requestGeneration !== undefined && requestGeneration !== initialLoadGeneration.current)
      ) {
        return false;
      }
      const normalized = normalizeRoleSmsPayload(body);
      setSmsMessages(normalized.messages);
      setSmsConversations(normalized.conversations);
      return true;
    } catch {
      return false;
    }
  }, [setSmsConversations, setSmsMessages, smsUiEnabled]);

  const loadInitialList = useCallback(async (): Promise<void> => {
    const requestGeneration = ++initialLoadGeneration.current;
    initialViewerCleanupRef.current?.();
    initialViewerCleanupRef.current = null;
    if (!sessionReady || !viewerId?.trim()) {
      setInitialListViewerId(null);
      setInitialListState("loading");
      setSelectedKey(null);
      return;
    }
    setInitialListViewerId(viewerId);
    setInitialListState("loading");
    const requestViewerEpoch = viewerEpochRef.current;
    const isCurrentRequest = () => requestGeneration === initialLoadGeneration.current &&
      requestViewerEpoch === viewerEpochRef.current;
    const viewer = observeCommunicationInitialViewer(viewerId);
    initialViewerCleanupRef.current = viewer.dispose;
    try {
      if (!viewer.isCurrent()) {
        setInitialListState("error");
        return;
      }
      const [inbox, smsOk] = await Promise.all([
        retryStaleCommunicationSource(
          () => syncPersistedInboxFromServerWithStatus(RESIDENT_INBOX_STORAGE_KEY),
          () => isCurrentRequest() && viewer.canRetry(),
        ),
        smsUiEnabled ? loadResidentSms(requestGeneration) : Promise.resolve(true),
      ]);
      if (!isCurrentRequest()) return;
      // A second stale result is recoverable through Retry, never an endless
      // skeleton. No partial membership is revealed if an enabled source fails.
      if (!viewer.isCurrent() || inbox.stale) {
        setInitialListState("error");
        return;
      }
      if (inbox.ok) setEmailThreads(inbox.rows);
      setInitialListState(inbox.ok && smsOk ? "ready" : "error");
    } catch {
      if (isCurrentRequest()) setInitialListState("error");
    } finally {
      viewer.dispose();
      if (initialViewerCleanupRef.current === viewer.dispose) initialViewerCleanupRef.current = null;
    }
  }, [
    loadResidentSms,
    sessionReady,
    setEmailThreads,
    setInitialListState,
    setInitialListViewerId,
    setSelectedKey,
    smsUiEnabled,
    viewerId,
  ]);

  useEffect(() => {
    void loadInitialList();
    return () => {
      initialLoadGeneration.current += 1;
      initialViewerCleanupRef.current?.();
      initialViewerCleanupRef.current = null;
    };
  }, [loadInitialList]);

  useEffect(() => {
    setSelectedKey(null);
  }, [listSegment]);

  // Same search the manager's list has. The two portals share one skeleton and
  // a resident with a year of charge notices needs to find a thread just as
  // much as a manager does.
  const [query, setQuery] = useState("");

  const filteredEmail = useMemo(() => {
    const base = filterEmailInboxThreads(emailThreads, { keepSmsLike: !smsUiEnabled });
    return withPinnedPropLaneAssistantThreads(base, "resident", viewerId, listSegment);
  }, [emailThreads, listSegment, smsUiEnabled, viewerId]);

  const partitionedEmail = useMemo(() => {
    if (listSegment === "archived") return filteredEmail.filter((thread) => thread.folder === "trash");
    if (includeArchived) return filteredEmail;
    return filteredEmail.filter((thread) => thread.folder !== "trash");
  }, [filteredEmail, includeArchived, listSegment]);

  const emailItems = useMemo((): UnifiedInboxListItem[] => {
    return propagateProvenManagerEvidence(partitionedEmail).map((t) => {
      const assistant = isPropLaneAssistantInboxThread(t);
      const msgs = inboxThreadMessages(t);
      const lastMsg = msgs[msgs.length - 1];
      const sentSemantics = t.folder === "sent";
      const explicitBindings = declaredSmsBindingKeys(t);
      const boundConversation = !assistant && explicitBindings.length === 1
        ? smsConversations.find((conversation) => conversation.conversationKey === explicitBindings[0]) ?? null
        : null;
      // A binding is server provenance. It selects only its own native thread;
      // the stored row can still be corrupt, so contradictory manager evidence
      // keeps the label and timeline isolated until the server repairs it.
      const boundConflict = Boolean(
        boundConversation && hasContradictoryStoredManagerEvidence(t, boundConversation),
      );
      const verifiedBoundConversation = boundConversation && !boundConflict ? boundConversation : null;
      const exactMatches = assistant || explicitBindings.length > 0
        ? []
        : smsConversations.filter((conversation) => conversationMatchesStoredManagerEvidence(t, conversation));
      const verifiedManager = verifiedBoundConversation ?? (exactMatches.length === 1 ? exactMatches[0] : null);
      const conflictingEvidence = !assistant && explicitBindings.length === 0 && smsConversations.some(
        (conversation) => hasConflictingStoredManagerEvidence(t, conversation),
      );
      const managerEmail = verifiedManager?.managerEmail.trim().toLowerCase() ?? "";
      const relationshipKey = residentRelationshipPersonKey(t, verifiedManager);
      const personKey = assistant
        ? undefined
        : boundConflict || explicitBindings.length > 1 || conflictingEvidence || !relationshipKey
          ? `email-isolated:${t.id}`
          : `resident-relationship:${relationshipKey}`;
      return {
        key: unifiedInboxKey("email", t.id),
        channel: "email" as const,
        threadId: t.id,
        name: verifiedManager?.managerName || (sentSemantics ? t.email || "Recipient" : t.from || t.email || "Sender"),
        subtitle: assistant
          ? propLaneAssistantListSubtitle(t)
          : t.subject,
        preview: assistant
          ? propLaneAssistantListPreview(t, listSegment)
          : communicationInboxListPreview(lastMsg?.body ?? t.preview ?? "", listSegment, 80),
        previewPrefix: inboxThreadLastTurnDirection(t) === "outbound" ? "You: " : undefined,
        time: t.time,
        unread: t.folder === "inbox" && t.unread,
        unreadCount: inboxThreadUnreadCount(t),
        address: homeAddress,
        category: inboxThreadCategoryLabel(t),
        // Sort on the SAME field the row is labelled with — only `thread.time`
        // is normalized; `lastMsg.at` is whatever shape its writer built.
        sortMs: inboxThreadSortMs(t.id, t.time),
        ...(personKey ? { personKey } : {}),
        ...(managerEmail ? { personEmail: managerEmail } : {}),
        ...(!assistant && explicitBindings.length > 0 ? {
          smsBindingKeys: explicitBindings,
          ...(explicitBindings.length === 1 ? { smsBindingKey: explicitBindings[0] } : {}),
        } : verifiedManager ? {
          smsBindingKey: verifiedManager.conversationKey,
          smsBindingKeys: [verifiedManager.conversationKey],
        } : {}),
        memberKeys: (t.sourceThreadIds ?? [t.id]).map((id) => unifiedInboxKey("email", id)),
        readSources: t.readSources,
        readSourcesComplete: t.readSourcesComplete,
      };
    });
  }, [homeAddress, listSegment, partitionedEmail, smsConversations]);

  const smsItems = useMemo((): UnifiedInboxListItem[] => {
    if (!smsUiEnabled) return [];
    const verified = smsConversations.flatMap((conversation): UnifiedInboxListItem[] => {
      const archived = smsArchived.has(conversation.conversationKey);
      if (listSegment === "archived" ? !archived : archived) return [];
      const scoped = conversation.messages;
      if (scoped.length === 0) return [];
      const last = [...scoped].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!;
      const unread = scoped.some((message) => message.direction === "inbound" && smsMessageBucket(message, smsOpened) === "unopened");
      const relationshipKey = residentManagerRelationshipKey(
        conversation.managerEmail,
        conversation.managerUserId,
        conversation.propertyId,
        conversation.conversationKey,
      );
      return [{
        key: unifiedInboxKey("sms", conversation.conversationKey),
        channel: "sms",
        threadId: conversation.conversationKey,
        personKey: relationshipKey
          ? `resident-relationship:${relationshipKey}`
          : `sms-isolated:${conversation.conversationKey}`,
        personEmail: conversation.managerEmail.trim().toLowerCase(),
        smsBindingKey: conversation.conversationKey,
        name: conversation.managerName,
        subtitle: conversation.propertyTitle || "Property manager",
        preview: communicationInboxListPreview(last.body, listSegment, 80),
        previewPrefix: last.direction === "outbound" ? "You: " : undefined,
        time: formatPacificDate(last.createdAt, { hour: "numeric", minute: "2-digit" }),
        unread,
        sortMs: Date.parse(last.createdAt) || 0,
      }];
    });
    const verifiedMessageIds = new Set(
      smsConversations.flatMap((conversation) => conversation.messages.map((message) => message.id)),
    );
    const unknownArchived = smsArchived.has(SMS_THREAD_ID);
    const scoped = smsMessages.filter((message) => !verifiedMessageIds.has(message.id));
    if (listSegment === "archived" ? !unknownArchived : unknownArchived) return verified;
    if (scoped.length === 0) return verified;
    const last = [...scoped].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!;
    const unread = scoped.some((m) => m.direction === "inbound" && smsMessageBucket(m, smsOpened) === "unopened");
    const item: UnifiedInboxListItem = {
      key: unifiedInboxKey("sms", SMS_THREAD_ID),
      channel: "sms",
      threadId: SMS_THREAD_ID,
      name: "Text messages",
      subtitle: "Property manager",
      preview: communicationInboxListPreview(last.body, listSegment, 80),
      previewPrefix: last.direction === "outbound" ? "You: " : undefined,
      time: formatPacificDate(last.createdAt, { hour: "numeric", minute: "2-digit" }),
      unread,
      sortMs: Date.parse(last.createdAt) || 0,
    };
    return [...verified, item];
  }, [listSegment, smsArchived, smsConversations, smsMessages, smsOpened, smsUiEnabled]);

  const searchMatchingMemberKeys = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const matches = new Set<string>();
    for (const thread of partitionedEmail) {
      const haystack = [
        thread.from,
        thread.email,
        thread.subject,
        thread.body,
        thread.preview,
        ...inboxThreadMessages(thread).map((message) => message.body),
      ].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(q)) continue;
      for (const id of thread.sourceThreadIds ?? [thread.id]) {
        matches.add(unifiedInboxKey("email", id));
      }
    }
    for (const conversation of smsConversations) {
      const archived = smsArchived.has(conversation.conversationKey);
      if (listSegment === "archived" ? !archived : archived) continue;
      const haystack = [
        conversation.managerName,
        conversation.managerEmail,
        conversation.propertyTitle,
        ...conversation.messages.map((message) => message.body),
      ].filter(Boolean).join(" ").toLowerCase();
      if (haystack.includes(q)) matches.add(unifiedInboxKey("sms", conversation.conversationKey));
    }
    const verifiedMessageIds = new Set(
      smsConversations.flatMap((conversation) => conversation.messages.map((message) => message.id)),
    );
    const unknownArchived = smsArchived.has(SMS_THREAD_ID);
    if (listSegment === "archived" ? unknownArchived : !unknownArchived) {
      const unknownMatches = smsMessages
        .filter((message) => !verifiedMessageIds.has(message.id))
        .some((message) => message.body.toLowerCase().includes(q));
      if (unknownMatches || "text messages".includes(q)) {
        matches.add(unifiedInboxKey("sms", SMS_THREAD_ID));
      }
    }
    return matches;
  }, [listSegment, partitionedEmail, query, smsArchived, smsConversations, smsMessages]);

  const presentationRows = useMemo(() => {
    let rows = mergeUnifiedInboxItems([...emailItems, ...smsItems], "recent");
    if (searchMatchingMemberKeys) {
      rows = rows.filter((row) => (row.memberKeys ?? [row.key]).some((key) => searchMatchingMemberKeys.has(key)));
    }
    return pinPropLaneAssistantUnifiedItems(rows, assistantThreadId).filter((row) => !readOnly || !row.unread);
  }, [assistantThreadId, emailItems, readOnly, searchMatchingMemberKeys, smsItems]);

  const selectedPresentationRow = useMemo(
    () => selectedKey
      ? presentationRows.find((row) => unifiedMemberKeys(row).has(selectedKey)) ?? null
      : null,
    [presentationRows, selectedKey],
  );

  // Retention is an acknowledgement affordance, not a bypass for the Unread
  // presentation. A changed viewer, filter, folder, or search starts a new
  // presentation and can never inherit a prior selected row.
  useEffect(() => {
    setUnreadSelectionAdmission(null);
  }, [includeArchived, listSegment, query, readOnly, viewerId]);

  useEffect(() => {
    if (!initialListReady || listSegment !== "unread" || !selectedPresentationRow?.unread) return;
    setUnreadSelectionAdmission({
      viewerId,
      listSegment,
      readOnly,
      includeArchived,
      query,
      memberKeys: unifiedMemberKeys(selectedPresentationRow),
    });
  }, [includeArchived, initialListReady, listSegment, query, readOnly, selectedPresentationRow, viewerId]);

  const unreadRetentionMemberKeys = useMemo((): ReadonlySet<string> | null => {
    const admission = unreadSelectionAdmission;
    if (
      listSegment !== "unread" ||
      !selectedPresentationRow ||
      selectedPresentationRow.unread ||
      !admission ||
      admission.viewerId !== viewerId ||
      admission.listSegment !== listSegment ||
      admission.readOnly !== readOnly ||
      admission.includeArchived !== includeArchived ||
      admission.query !== query ||
      !hasExactUnifiedMemberContinuity(selectedPresentationRow, admission.memberKeys)
    ) return null;
    return admission.memberKeys;
  }, [includeArchived, listSegment, query, readOnly, selectedPresentationRow, unreadSelectionAdmission, viewerId]);

  const retainJustReadUnreadSelection = unreadRetentionMemberKeys !== null;

  const merged = useMemo(() => {
    if (listSegment !== "unread") return presentationRows;
    return presentationRows.filter((row) =>
      row.unread ||
      (unreadRetentionMemberKeys !== null && hasExactUnifiedMemberContinuity(row, unreadRetentionMemberKeys)),
    );
  }, [listSegment, presentationRows, unreadRetentionMemberKeys]);

  const bulk = useUnifiedCommunicationBulk({
    mergedRows: merged,
    listSegment,
    storageKey: RESIDENT_INBOX_STORAGE_KEY,
    emailThreads,
    assistantPlaceholder: viewerId ? buildResidentAssistantPlaceholderThread(viewerId) : undefined,
    onEmailThreadsChange: setEmailThreads,
    archiveSmsConversation: async (conversationId) => {
      setSmsArchived((current) => {
        const next = new Set(current);
        next.add(conversationId);
        window.localStorage.setItem(residentSmsArchiveKey(viewerId), JSON.stringify([...next]));
        return next;
      });
    },
    restoreSmsConversation: async (conversationId) => {
      setSmsArchived((current) => {
        const next = new Set(current);
        next.delete(conversationId);
        window.localStorage.setItem(residentSmsArchiveKey(viewerId), JSON.stringify([...next]));
        return next;
      });
    },
    onSelectionCleared: () => {
      setSelectedKey(null);
      onRouteThreadChange?.(undefined);
      clearCommunicationThreadUrl(`${commBase}/${listSegment}`);
    },
  });

  const selection = useMemo(
    () => (initialListReady && selectedKey ? parseUnifiedInboxKey(selectedKey) : null),
    [initialListReady, selectedKey],
  );
  const selectedRow = useMemo(
    () => (selectedKey ? merged.find((row) => row.key === selectedKey) ?? null : null),
    [merged, selectedKey],
  );
  const selectedMemberKeys = selectedRow?.memberKeys ?? (selectedRow ? [selectedRow.key] : []);
  const selectedEmailThreadId = selectedMemberKeys
    .map(parseUnifiedInboxKey)
    .find((member): member is { channel: "email"; threadId: string } => member?.channel === "email")?.threadId ?? null;
  const selectedEmailThreadIds = selectedMemberKeys
    .map(parseUnifiedInboxKey)
    .filter((member): member is { channel: "email"; threadId: string } => member?.channel === "email")
    .map((member) => member.threadId);
  const selectedSmsConversations = selectedMemberKeys
    .map(parseUnifiedInboxKey)
    .filter((member): member is { channel: "sms"; threadId: string } => member?.channel === "sms")
    .map((member) => smsConversations.find((conversation) => conversation.conversationKey === member.threadId))
    .filter((conversation): conversation is RoleSmsManagerConversation => Boolean(conversation));
  const selectedSmsMessages = selection?.channel === "sms" && selection.threadId === SMS_THREAD_ID
    ? smsMessages.filter((message) => !smsConversations.some((conversation) =>
        conversation.messages.some((candidate) => candidate.id === message.id),
      ))
    : selectedSmsConversations.flatMap((conversation) => conversation.messages);
  const routeRow = useMemo(() => {
    if (!routeThreadId) return null;
    return merged.find((row) => {
      if (row.threadId === routeThreadId) return true;
      return (row.memberKeys ?? [row.key]).some((key) => {
        const member = parseUnifiedInboxKey(key);
        if (!member) return false;
        if (member.threadId === routeThreadId) return true;
        if (member.channel !== "email") return false;
        return emailThreads.some((thread) =>
          thread.id === member.threadId && thread.sourceThreadIds?.includes(routeThreadId),
        );
      });
    }) ?? null;
  }, [emailThreads, merged, routeThreadId]);

  useEffect(() => {
    if (!routeThreadId) {
      resolvedRouteRef.current = null;
    } else if (routeRow) {
      // Once a route was visible for this resident, an explicit presentation
      // change that excludes it must clear the stale route instead of letting
      // a later selection effect restore it.
      resolvedRouteRef.current = { threadId: routeThreadId, viewerId };
    } else if (resolvedRouteRef.current?.viewerId !== viewerId) {
      resolvedRouteRef.current = null;
    }
  }, [routeRow, routeThreadId, viewerId]);

  useEffect(() => {
    if (!initialListReady) return;
    if (!routeThreadId) return;
    if (routeRow) setSelectedKey(routeRow.key);
  }, [initialListReady, routeRow, routeThreadId]);

  useEffect(() => {
    const inboundIds = selectedSmsMessages
      .filter((message) => message.direction === "inbound")
      .map((message) => message.id);
    if (inboundIds.length === 0 || inboundIds.every((id) => smsOpened.has(id))) return;
    setSmsOpened((current) => {
      const next = new Set(current);
      inboundIds.forEach((id) => next.add(id));
      persistOpenedIds(next);
      return next;
    });
  }, [selectedSmsMessages, smsOpened]);

  useEffect(() => {
    if (!initialListReady || !selectedRow?.unread || selectedRow.readSourcesComplete !== true) return;
    const sources = selectedRow.readSources ?? [];
    if (sources.length === 0) return;
    const observation = sources.map((source) => `${source.id}:${source.observation}`).sort().join("|");
    const viewer = viewerIdRef.current?.trim();
    const selection = selectedKeyRef.current;
    if (!observation || !viewer || !selection) return;
    const signature = `${viewer}:${selection}:${observation}`;
    if (readSucceededRef.current.has(signature) || readInFlightRef.current.has(signature)) return;
    const attempts = readAttemptsRef.current.get(signature) ?? 0;
    if (attempts >= 2) return;
    readAttemptsRef.current.set(signature, attempts + 1);
    const requestToken = {};
    readInFlightRef.current.set(signature, requestToken);
    const requestViewer = viewer;
    const requestSelection = selection;
    const requestGeneration = initialLoadGeneration.current;
    void markPersistedInboxSourcesRead(RESIDENT_INBOX_STORAGE_KEY, sources)
      .then(async (results) => {
        const current = viewerIdRef.current === requestViewer &&
          selectedKeyRef.current === requestSelection &&
          initialLoadGeneration.current === requestGeneration;
        if (!results || results.some((result) => result.status === "failed")) return;
        if (!current) return;
        readSucceededRef.current.add(signature);
        try {
          const synced = await syncPersistedInboxFromServerWithStatus(RESIDENT_INBOX_STORAGE_KEY, { force: true });
          if (
            viewerIdRef.current === requestViewer &&
            selectedKeyRef.current === requestSelection &&
            initialLoadGeneration.current === requestGeneration &&
            synced.ok && !synced.stale
          ) setEmailThreads(synced.rows);
        } catch {
          // The acknowledgement succeeded. A refresh failure must not turn it
          // into another POST or leave the row in an in-flight state.
        }
      })
      .catch(() => {
        // Failed transport releases the attempt for a bounded retry when the
        // resident reopens or refreshes the unchanged observation.
      })
      .finally(() => {
        if (readInFlightRef.current.get(signature) === requestToken) {
          readInFlightRef.current.delete(signature);
        }
      });
  }, [initialListReady, selectedRow]);

  useEffect(() => {
    onThreadOpenChange?.(Boolean(selection));
  }, [onThreadOpenChange, selection]);

  useEffect(() => {
    onThreadSelectedChange?.(Boolean(selection));
  }, [onThreadSelectedChange, selection]);

  useEffect(() => {
    if (!initialListReady) return;
    if (merged.length === 0) {
      const routeWasResolved =
        resolvedRouteRef.current?.threadId === routeThreadId &&
        resolvedRouteRef.current?.viewerId === viewerId;
      if (routeThreadId && routeWasResolved && !retainJustReadUnreadSelection) {
        setSelectedKey(null);
        onRouteThreadChange?.(undefined);
        clearCommunicationThreadUrl(`${commBase}/${listSegment}`);
      } else if (!routeThreadId && !retainJustReadUnreadSelection) {
        setSelectedKey(null);
      }
      return;
    }
    const routeWasResolved =
      resolvedRouteRef.current?.threadId === routeThreadId &&
      resolvedRouteRef.current?.viewerId === viewerId;
    if (routeThreadId && routeWasResolved && !routeRow && !retainJustReadUnreadSelection) {
      setSelectedKey(null);
      onRouteThreadChange?.(undefined);
      clearCommunicationThreadUrl(`${commBase}/${listSegment}`);
      return;
    }
    setSelectedKey((cur) => {
      if (routeThreadId) {
        if (routeRow) return routeRow.key;
        if (cur && merged.some((row) => row.key === cur)) return cur;
        return null;
      }
      if (cur && merged.some((row) => row.key === cur)) return cur;
      if (inboxUsesDesktopSplit()) return merged[0]!.key;
      return null;
    });
  }, [commBase, initialListReady, listSegment, merged, onRouteThreadChange, retainJustReadUnreadSelection, routeRow, routeThreadId, viewerId]);

  const listPane = (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <ResidentManagerNumberCard />
      <div className={PORTAL_INBOX_LIST_TOOLBAR_CLASS}>
        <div className="relative min-w-0">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search messages"
            aria-label="Search messages"
            className="portal-inbox-search h-9 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/15"
            data-attr="resident-inbox-search"
          />
        </div>
        {initialListReady && merged.length > 0 ? (
          <p className="hidden px-1 text-[11px] text-muted sm:block">
            {merged.length} conversation{merged.length === 1 ? "" : "s"}
            {query.trim() ? ` matching \u201C${query.trim()}\u201D` : ""}
          </p>
        ) : null}
      </div>
      <div className={`${INBOX_LIST_SCROLL} min-h-0 flex-1`} data-communication-inbox-list>
        {!initialListReady ? (
          <CommunicationInboxInitialState
            error={initialListState === "error"}
            onRetry={loadInitialList}
          />
        ) : merged.length === 0 ? (
          query.trim() ? (
            <div className="p-4">
              <PortalInboxEmptyState title={`No messages match \u201C${query.trim()}\u201D.`} />
            </div>
          ) : listSegment === "archived" ? (
            <div className="p-4">
              <PortalInboxEmptyState title="No archived conversations." />
            </div>
          ) : listSegment === "unread" ? (
            <div className="p-4">
              <PortalInboxEmptyState title="No unread conversations." />
            </div>
          ) : null
        ) : (
          merged.map((row) => (
            <InboxConversationRow
              key={row.key}
              trailing={<CommunicationRowActions row={row} bulk={bulk} archived={listSegment === "archived"} emailThreads={emailThreads} allowSmsActions />}
              name={row.name}
              subtitle={row.subtitle}
              preview={row.preview}
              previewPrefix={row.previewPrefix}
              time={row.time}
              unread={row.unread}
              unreadCount={row.unreadCount}
              address={row.address}
              category={row.category}
              selected={selectedKey === row.key}
              onOpen={() => {
                setSelectedKey(row.key);
                onRouteThreadChange?.(row.threadId);
                const href = `${commBase}/${listSegment}/${encodeURIComponent(row.threadId)}`;
                if (routeThreadId !== row.threadId) {
                  selectCommunicationThreadUrl(href, { replaceExisting: Boolean(routeThreadId) });
                }
              }}
            />
          ))
        )}
      </div>
    </div>
  );

  const smsSelected = selection?.channel === "sms" && !selectedEmailThreadId;
  const threadPane = (
    <>
      {smsSelected ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
          <ResidentSmsTimeline
            messages={selectedSmsMessages}
            title={selectedRow?.name || "Text messages"}
            threadKey={selectedRow?.key ?? SMS_THREAD_ID}
            onBack={() => {
              setSelectedKey(null);
              onRouteThreadChange?.(undefined);
              clearCommunicationThreadUrl(`${commBase}/${listSegment}`);
            }}
          />
        </div>
      ) : null}
      <div className={smsSelected ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
        <ResidentInboxPanel
          ref={inboxRef}
          tabId={listSegment === "archived" ? "trash" : "all"}
          embeddedInCommunication
          externalTitleActions
          suppressListPane
          smsUiEnabled={smsUiEnabled}
          controlledExpandedId={selectedEmailThreadId}
          communicationEmailThreadIds={selectedEmailThreadIds}
          communicationSmsMessages={selectedSmsMessages}
          communicationThreadTitle={selectedSmsConversations[0]?.managerName}
          disableAutoMarkRead
          onControlledExpandedIdChange={(id) => {
            if (!id) {
              setSelectedKey(null);
              onRouteThreadChange?.(undefined);
              clearCommunicationThreadUrl(`${commBase}/${listSegment}`);
              return;
            }
            const selected = merged.find((row) => (row.memberKeys ?? [row.key]).some((key) => {
              const member = parseUnifiedInboxKey(key);
              return member?.channel === "email" && member.threadId === id;
            }));
            const nextKey = selected?.key ?? unifiedInboxKey("email", id);
            const nextThreadId = selected?.threadId ?? id;
            setSelectedKey(nextKey);
            onRouteThreadChange?.(nextThreadId);
            const href = `${commBase}/${listSegment}/${encodeURIComponent(nextThreadId)}`;
            if (routeThreadId !== nextThreadId) {
              selectCommunicationThreadUrl(href, { replaceExisting: Boolean(routeThreadId) });
            }
          }}
        />
      </div>
    </>
  );

  return (
    <>
      <InboxTwoPane
        panes="split"
        heightMode="viewport"
        fillViewport={Boolean(selection)}
        fillParent
        mobileCompact
        className="min-h-0 flex-1"
        threadOpen={Boolean(selection)}
        list={listPane}
        thread={threadPane}
      />
    </>
  );
}

/** @deprecated Folder tabs removed; kept so legacy routes still resolve. */
export type ResidentEmailTabId = "unopened" | "opened" | "schedule" | "sent" | "trash";

export function ResidentCommunication({
  listSegment = "active",
  threadId,
  smsUiEnabled = false,
  residentUserId = null,
}: {
  /** Routed conversation list segment (Active / Unread / Archived). */
  listSegment?: InboxListSegment;
  /** Deep-linked thread id from `/communication/{segment}/{threadId}`. */
  threadId?: string;
  /** @deprecated Folder tabs removed; kept so legacy routes still resolve. */
  inboxTabId?: ResidentEmailTabId;
  smsUiEnabled?: boolean;
  residentUserId?: string | null;
}) {
  const commBase = `${RESIDENT_PORTAL_BASE_PATH}/communication`;
  const inboxRef = useRef<ResidentInboxPanelHandle>(null);
  const { activeThreadId, setActiveThreadId } = useCommunicationThreadId(commBase, threadId);
  const [threadOpen, setThreadOpen] = useState(Boolean(threadId));
  const [threadSelected, setThreadSelected] = useState(Boolean(threadId));
  const [status, setStatus] = useState<CommunicationStatus>(listSegment);
  useEffect(() => setStatus(listSegment), [listSegment]);

  const communicationFilterSheet = (
    <PortalFilterSortSheet
      activeCount={status === "active" ? 0 : 1}
      compactPanel
      filterFieldCount={1}
      // Content width — see the note on the manager's sheet.
      className="md:w-auto md:max-w-none"
      mobileFlushBody
      dataAttr="resident-communication-filter-open"
    >
      <CommunicationStatusFilterDraft value={status} onChange={setStatus} />
    </PortalFilterSortSheet>
  );

  const openCompose = () => inboxRef.current?.openCompose();

  const communicationNewMessageButton = (
    <Button
      type="button"
      variant="primary"
      className={PORTAL_HEADER_PRIMARY_ACTION_BTN}
      data-attr="communication-new-message"
      aria-label="New message"
      onClick={openCompose}
    >
      <span className="sm:hidden" aria-hidden="true">
        Message
      </span>
      <span className="hidden sm:inline">New message</span>
    </Button>
  );

  // Band-only shape: this aside is UNGATED, so it renders once at every
  // breakpoint. Never pair it with a separate mobile actions row — that draws
  // every control twice on a phone. Guarded by
  // tests/unit/portal-inline-title-band-duplicate-controls.test.tsx.
  const communicationCommandActions = (
    <>
      {communicationFilterSheet}
      {communicationNewMessageButton}
    </>
  );

  return (
    <PortalCommunicationShell
      title="Inbox"

      titleAside={communicationCommandActions}
      hideTitleOnMobileNav
      hideMobileFilterRow={threadOpen}
      mobileThreadReading={threadOpen}
      threadSelected={threadSelected}
      hideAssistantFab
    >
      <ResidentUnifiedInbox
        inboxRef={inboxRef}
        smsUiEnabled={smsUiEnabled}
        listSegment={status === "read" || status === "all" ? "active" : status}
        readOnly={status === "read"}
        includeArchived={status === "all"}
        routeThreadId={activeThreadId}
        onRouteThreadChange={setActiveThreadId}
        onThreadOpenChange={setThreadOpen}
        onThreadSelectedChange={setThreadSelected}
        commBase={commBase}
        onAddConversation={() => inboxRef.current?.openCompose()}
        residentUserId={residentUserId}
      />
    </PortalCommunicationShell>
  );
}
