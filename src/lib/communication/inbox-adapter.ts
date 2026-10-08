/**
 * The seam between the unified Communication inbox (`ManagerUnifiedInbox`) and
 * the portal that mounts it.
 *
 * The inbox is one component with two data sources: the manager's own
 * conversations (persisted inbox cache, SMS projection, applications directory,
 * the PropLane Assistant thread) and the admin's (the `scope: "admin"` inbox
 * rows, the shared-line SMS stream). Everything that differs between the two
 * lives behind this adapter; the list model, merge rules, Active | Archived
 * tabs, selection, bulk mutations and the two-pane chrome are shared, so the two
 * pages cannot drift apart again.
 *
 * Both adapters satisfy the same contract
 * (`tests/unit/communication-inbox-adapter-contract.test.ts`). The manager
 * adapter is a thin wrapper over the calls the inbox always made - it must not
 * change what the manager page does.
 */
import type { ComponentType, ReactNode } from "react";
import type {
  PersistedInboxSyncResult,
  PersistedInboxThread,
} from "@/lib/portal-inbox-storage";
import type { ManagerAssistantWorkspace } from "@/lib/communication-manager-assistant-thread";
import type { ManagerSmsResidentConversation } from "@/lib/manager-sms-messages";
import type { UnifiedInboxListItem } from "@/lib/unified-inbox-merge";
import type { InboxListSegment } from "@/components/portal/portal-inbox-ui";

export type InboxAdapterKind = "manager" | "admin";

/** Result of a directory (applications / contacts) sync; an absent directory counts as ready. */
export type InboxDirectorySyncResult = { ok: boolean; stale?: boolean };

export type InboxEmailMutationResult = { ok: boolean; next: PersistedInboxThread[] };

/** Email-thread mutations. The manager defaults are the storage-key based ones. */
export type InboxEmailMutations = {
  archive(ids: string[]): Promise<InboxEmailMutationResult>;
  restore(ids: string[]): Promise<InboxEmailMutationResult>;
  deleteForever(ids: string[]): Promise<InboxEmailMutationResult>;
};

export type InboxSmsLoadArgs = {
  viewerId: string;
  force: boolean;
  workspaceId?: string | null;
  cursor?: string | null;
};

export type InboxListThreadsContext = {
  viewerId: string | null | undefined;
  workspace: ManagerAssistantWorkspace | null;
  smsUiEnabled: boolean;
};

/** What the inbox hands the adapter when the portal draws the thread pane itself. */
export type InboxThreadPaneContext = {
  selection: { channel: "email" | "sms"; threadId: string };
  selectedRow: UnifiedInboxListItem | null;
  /** Every stored email thread folded into the selected conversation. */
  emailThreads: PersistedInboxThread[];
  /** Every text conversation folded into the selected conversation. */
  smsResidents: ManagerSmsResidentConversation[];
  listSegment: InboxListSegment;
  smsUiEnabled: boolean;
  /** Closes the open conversation (back to the list). */
  closeThread: () => void;
  archive: () => Promise<void>;
  restore: () => Promise<void>;
  deleteForever: () => Promise<void>;
  /** Re-reads the thread rows after the pane changed one (reply, schedule, read). */
  reloadThreads: () => Promise<void>;
  /** Called by a text pane after it archived / restored its conversation. */
  onSmsProjectionStateChanged: () => void;
  onSmsConversationOpened: () => void;
};

export type CommunicationInboxAdapter = {
  kind: InboxAdapterKind;

  // ---- email / in-app threads -------------------------------------------
  /** Cache + mutation key for the thread rows. */
  storageKey: string;
  /** Window event fired when the cached thread rows change. */
  threadsChangedEvent: string;
  loadCachedThreads(): PersistedInboxThread[];
  stageThreads(rows: PersistedInboxThread[]): void;
  syncThreads(opts?: { force?: boolean }): Promise<PersistedInboxSyncResult>;
  /** The rows the list is built from (manager: collapsed + assistant pinned). */
  buildListThreads(rows: PersistedInboxThread[], ctx: InboxListThreadsContext): PersistedInboxThread[];
  /** Overrides the storage-key based archive / restore / delete (admin has its own store). */
  emailMutations?: InboxEmailMutations;
  /** The PropLane Assistant thread is pinned into the list (manager only). */
  pinsAssistant: boolean;
  /** Folded email + SMS conversations render through the direct chat pane (manager only). */
  directChat: boolean;
  /**
   * A sent thread's `from` already names the person it is with (admin stores the
   * recipient's name there), so the row titles by it instead of an address.
   */
  namesSentThreadsByFrom?: boolean;

  // ---- directory (applications / contacts) -------------------------------
  syncDirectory?(viewerId: string): Promise<InboxDirectorySyncResult>;

  // ---- SMS ---------------------------------------------------------------
  loadSmsConversations(args: InboxSmsLoadArgs): Promise<Response>;
  invalidateSmsConversations(...args: [viewerId?: string | null, workspaceId?: string | null]): void;
  /** Detail read for one conversation; absent = the surface has no per-conversation read. */
  smsDetailPath?(id: string): string;
  /** SMS rows can be archived / restored / deleted from the list. */
  smsArchivable: boolean;

  // ---- chrome ------------------------------------------------------------
  /** The identity boxes (work number / work email) above the list. */
  identityBoxes: ReactNode;
  /** The thread pane, when the portal draws its own (admin). The manager leaves it to the inbox. */
  ThreadPane?: ComponentType<InboxThreadPaneContext>;
};
