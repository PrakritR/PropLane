"use client";

/**
 * The admin's data adapter for the unified Communication inbox.
 *
 * Admin conversations are `scope: "admin"` inbox rows (support@ mail, portal
 * users writing to PropLane, messages admin composed) and the shared-line text
 * stream. Both arrive in the one conversation list the manager has; this adapter
 * says where they come from and how they are archived, replied to and scheduled
 * (`CommunicationInboxAdapter`, `docs/agents/communication-inbox.md`).
 */
import { adminSmsConversationsUrl, publishAdminSmsWorkspaces } from "@/lib/admin-sms-workspaces";
import { ADMIN_UI_EVENT } from "@/lib/demo-admin-ui";
import { AdminThreadPane } from "@/components/portal/admin-thread-pane";
import { AdminWorkIdentityCard, publishAdminWorkNumber } from "@/components/portal/admin-work-identity-card";
import {
  isManagerAgentNoticeThreadId,
  type ManagerAssistantWorkspace,
} from "@/lib/communication-manager-assistant-thread";
import type { CommunicationInboxAdapter } from "@/lib/communication/inbox-adapter";
import {
  ADMIN_INBOX_STORAGE_KEY,
  adminCachedThreads,
  adminEmailMutations,
  syncAdminThreads,
} from "@/lib/admin-inbox-source";

/** The viewer's default-workspace chat (the unsuffixed `agent_notice_<id>`), whatever workspace the admin last opened. */
const ADMIN_ASSISTANT_WORKSPACE: ManagerAssistantWorkspace = { id: "", isDefault: true };

/** A successful, empty answer: the text stream is switched off, so there are no rows to read. */
function emptySmsResponse(): Response {
  return new Response(JSON.stringify({ residents: [], nextCursor: null }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export function createAdminInboxAdapter({
  smsUiEnabled,
  workspaceFilter = "",
}: {
  smsUiEnabled: boolean;
  /** The Filter popover's Workspace value: "" = every workspace, "unassigned", or one service workspace id. */
  workspaceFilter?: string;
}): CommunicationInboxAdapter {
  return {
    kind: "admin",

    storageKey: ADMIN_INBOX_STORAGE_KEY,
    threadsChangedEvent: ADMIN_UI_EVENT,
    loadCachedThreads: adminCachedThreads,
    // The pinned Assistant chat is read from its own endpoint, never staged into the admin store.
    stageThreads: () => {},
    syncThreads: syncAdminThreads,
    // An Assistant chat is private to its owner: only the viewer's own can ever be drawn, whatever the store holds.
    buildListThreads: (rows, ctx) =>
      rows.filter((row) => !isManagerAgentNoticeThreadId(row.id) || (Boolean(ctx.viewerId) && isManagerAgentNoticeThreadId(row.id, ctx.viewerId))),
    emailMutations: adminEmailMutations,
    // The viewer's OWN PropLane Assistant is first in the list: texts from their verified phone to the PropLane line land
    // there, and no other admin's ever does.
    pinsAssistant: true,
    assistantWorkspace: ADMIN_ASSISTANT_WORKSPACE,
    directChat: false,
    namesSentThreadsByFrom: true,

    loadSmsConversations: async () => {
      if (!smsUiEnabled) return emptySmsResponse();
      const res = await fetch(adminSmsConversationsUrl(workspaceFilter), { credentials: "include", cache: "no-store" });
      if (res.ok) {
        // The identity box reads the line off the same answer - no second request; the Workspace filter reads its list.
        try {
          const body = (await res.clone().json()) as { workNumber?: string | null; workspaces?: unknown };
          publishAdminWorkNumber(body.workNumber ?? null);
          publishAdminSmsWorkspaces(body.workspaces);
        } catch {
          /* the list reads its own copy */
        }
      }
      return res;
    },
    invalidateSmsConversations: () => {},
    smsArchivable: false,

    identityBoxes: <AdminWorkIdentityCard />,
    ThreadPane: AdminThreadPane,
  };
}
