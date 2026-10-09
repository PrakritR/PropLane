"use client";

/**
 * The manager's data adapter for the unified Communication inbox.
 *
 * Every function here is the call `ManagerUnifiedInbox` always made against the
 * manager's own sources; moving them behind `CommunicationInboxAdapter` is what
 * lets the admin page mount the same component. Do not change behaviour here -
 * the manager page must stay exactly as it was
 * (`tests/unit/communication-inbox-adapter-contract.test.ts`).
 */
import { ManagerWorkNumberCard } from "@/components/portal/pro-work-number-card";
import { buildActiveCommunicationThreads } from "@/lib/communication-active-rows";
import type { CommunicationInboxAdapter } from "@/lib/communication/inbox-adapter";
import {
  invalidateManagerSmsConversationsClient,
  loadManagerSmsConversationsClient,
} from "@/lib/manager-sms-conversations-client";
import { syncManagerApplicationsFromServerWithStatus } from "@/lib/manager-applications-storage";
import {
  MANAGER_INBOX_STORAGE_KEY,
  PORTAL_INBOX_CHANGED_EVENT,
  loadPersistedInbox,
  stagePersistedInboxRows,
  syncPersistedInboxFromServerWithStatus,
} from "@/lib/portal-inbox-storage";

export const managerInboxAdapter: CommunicationInboxAdapter = {
  kind: "manager",

  storageKey: MANAGER_INBOX_STORAGE_KEY,
  threadsChangedEvent: PORTAL_INBOX_CHANGED_EVENT,
  loadCachedThreads: () => loadPersistedInbox(MANAGER_INBOX_STORAGE_KEY, []),
  stageThreads: (rows) => stagePersistedInboxRows(MANAGER_INBOX_STORAGE_KEY, rows),
  // One argument when there are no options: the direct-send refresh passes
  // `{ force: true }`, the initial load passes nothing.
  syncThreads: (opts) =>
    opts
      ? syncPersistedInboxFromServerWithStatus(MANAGER_INBOX_STORAGE_KEY, opts)
      : syncPersistedInboxFromServerWithStatus(MANAGER_INBOX_STORAGE_KEY),
  // The exact rows the Active tab shows - shared with the sidebar badge so the
  // two can never drift (`communication-active-rows.ts`).
  buildListThreads: (rows, ctx) =>
    buildActiveCommunicationThreads(rows, {
      portal: "manager",
      viewerId: ctx.viewerId,
      workspace: ctx.workspace,
      smsUiEnabled: ctx.smsUiEnabled,
    }),
  pinsAssistant: true,
  directChat: true,

  syncDirectory: (viewerId) => syncManagerApplicationsFromServerWithStatus({ managerUserId: viewerId }),

  loadSmsConversations: ({ viewerId, force, workspaceId, cursor }) =>
    loadManagerSmsConversationsClient(viewerId, force, workspaceId, cursor),
  // Rest args keep the caller's arity (one id on a viewer switch, two on a mutation).
  invalidateSmsConversations: (...args) => invalidateManagerSmsConversationsClient(...args),
  smsDetailPath: (id) => `/api/manager/sms-conversations/${encodeURIComponent(id)}`,
  smsArchivable: true,

  identityBoxes: <ManagerWorkNumberCard />,
};
