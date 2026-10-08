"use client";

/**
 * The open conversation on the admin Communication page.
 *
 * The list, tabs, selection and bulk actions are the manager's
 * (`ManagerUnifiedInbox`); this is the thread side for admin's own data: the
 * messages of the stored conversation(s), a reply composer wired to
 * `POST /api/admin/inbox-reply`, "Schedule for later" for portal users, and the
 * pending scheduled sends drawn in the bar under the name with their Cancel.
 * Text conversations open the shared SMS thread against the admin SMS endpoint.
 *
 * Nothing is appended before the send is authorized: a reply is added to the
 * thread only after the server accepted it (`/api/admin/inbox-reply`), the same
 * authorize-then-append order every other inbox keeps.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, RotateCcw, Trash2 } from "lucide-react";
import {
  INBOX_THREAD_ICON_BTN,
  INBOX_THREAD_ICON_BTN_DANGER,
  InboxComposer,
  InboxThreadView,
} from "@/components/portal/portal-inbox-ui";
import { InboxComposerScheduleMenu } from "@/components/portal/inbox-composer-tools";
import { defaultScheduleSendAtLocal } from "@/components/portal/portal-message-compose-fields";
import { ManagerSmsPanel } from "@/components/portal/pro-sms-panel";
import {
  useThreadScheduledCards,
  useThreadScheduledItems,
} from "@/components/portal/use-thread-scheduled-cards";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { ADMIN_REPLY_AUTHOR_LABEL, adminThreadBubbles, isAdminScheduledStubId } from "@/lib/admin-inbox-threads";
import { refreshAdminScheduled } from "@/lib/admin-inbox-source";
import type { InboxThreadPaneContext } from "@/lib/communication/inbox-adapter";
import {
  appendThreadReply,
  markInboxMessageRead,
  readInboxMessages,
  syncInboxMessagesFromServer,
} from "@/lib/demo-admin-partner-inbox";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { inboxThreadSortMs } from "@/lib/portal-inbox-storage";

function isPortalCounterpartyRole(role: string | undefined): boolean {
  return role === "manager" || role === "resident" || role === "vendor";
}

function AdminEmailThread(ctx: InboxThreadPaneContext) {
  const { showToast } = useAppUi();
  const archived = ctx.listSegment === "archived";

  // Oldest first, so the newest stored thread is the one a reply lands on.
  const threads = useMemo(
    () =>
      [...ctx.emailThreads].sort(
        (a, b) => inboxThreadSortMs(a.id, a.time) - inboxThreadSortMs(b.id, b.time),
      ),
    [ctx.emailThreads],
  );
  const primary = threads[threads.length - 1] ?? null;
  const stored = useMemo(() => {
    const byId = new Map(readInboxMessages().map((message) => [message.id, message]));
    return byId.get(primary?.id ?? "") ?? null;
    // `threads` changes whenever the store does (the list re-derives from it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primary?.id, threads]);

  const email = primary?.email?.trim() ?? "";
  const title = ctx.selectedRow?.name ?? primary?.from ?? "Conversation";
  const bubbles = useMemo(() => adminThreadBubbles(threads), [threads]);
  const stub = primary ? isAdminScheduledStubId(primary.id) : false;
  const canReply = Boolean(stored) && !archived;
  const canSchedule = canReply && Boolean(email) && isPortalCounterpartyRole(stored?.senderRole);

  // Opening a message reads it - the same as every other inbox.
  useEffect(() => {
    for (const thread of threads) {
      if (thread.folder === "inbox" && thread.unread) markInboxMessageRead(thread.id);
    }
  }, [threads]);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [scheduleLater, setScheduleLater] = useState(false);
  const [scheduleSendAt, setScheduleSendAt] = useState(() => defaultScheduleSendAtLocal());

  const { scheduledCards, reloadScheduled } = useThreadScheduledCards({
    recipientEmail: email,
    smsAvailable: false,
    enabled: Boolean(email) && !archived,
    // Admin has no automated payment reminders; only its own scheduled sends.
    includeAutomation: false,
  });

  // A cancel or send-now inside a card changes the published list; pull the
  // list's own copy back so a conversation drawn only for a scheduled send
  // disappears with it. Skips the first run so opening a thread costs no extra read.
  const publishedScheduled = useThreadScheduledItems(email);
  const lastScheduledCount = useRef<number | null>(null);
  useEffect(() => {
    const previous = lastScheduledCount.current;
    lastScheduledCount.current = publishedScheduled.length;
    if (previous !== null && previous !== publishedScheduled.length) void refreshAdminScheduled();
  }, [publishedScheduled.length]);

  const submitSchedule = useCallback(async (text: string): Promise<boolean> => {
    const sendAt = new Date(scheduleSendAt);
    if (Number.isNaN(sendAt.getTime())) {
      showToast("Choose a valid send date and time.");
      return false;
    }
    if (sendAt.getTime() < Date.now() - 60_000) {
      showToast("Send time must be in the future.");
      return false;
    }
    try {
      const res = await fetch("/api/portal/scheduled-inbox-messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          subject: primary?.subject || `Message for ${title}`,
          body: text,
          sendAt: sendAt.toISOString(),
          recipientEmail: email,
          recipientName: title,
          deliverViaEmail: false,
        }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        showToast(payload?.error ?? "Could not schedule message.");
        return false;
      }
      showToast("Message scheduled.");
      reloadScheduled();
      void refreshAdminScheduled();
      return true;
    } catch {
      showToast("Could not schedule message.");
      return false;
    }
  }, [email, primary?.subject, reloadScheduled, scheduleSendAt, showToast, title]);

  const submitReply = useCallback(async (text: string): Promise<boolean> => {
    if (!stored) return false;
    if (isDemoModeActive()) {
      if (appendThreadReply(stored.id, ADMIN_REPLY_AUTHOR_LABEL, text)) {
        showToast("Reply sent.");
        return true;
      }
      showToast("Could not add reply.");
      return false;
    }
    try {
      const res = await fetch("/api/admin/inbox-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ threadId: stored.id, text }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        showToast(data.error ?? "Could not send reply.");
        return false;
      }
      await syncInboxMessagesFromServer({ force: true });
      showToast("Reply sent.");
      return true;
    } catch {
      showToast("Could not send reply.");
      return false;
    }
  }, [showToast, stored]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const ok = scheduleLater && canSchedule ? await submitSchedule(text) : await submitReply(text);
      // Clear only on success, so a refused send never loses what was typed.
      if (ok) {
        setDraft("");
        setScheduleLater(false);
      }
    } finally {
      setSending(false);
    }
  }, [canSchedule, draft, scheduleLater, sending, submitReply, submitSchedule]);

  const headerActions = archived ? (
    <>
      <button
        type="button"
        className={INBOX_THREAD_ICON_BTN}
        aria-label="Restore conversation"
        title="Restore"
        data-attr="admin-communication-restore"
        onClick={() => void ctx.restore()}
      >
        <RotateCcw className="h-4 w-4" aria-hidden />
      </button>
      <button
        type="button"
        className={INBOX_THREAD_ICON_BTN_DANGER}
        aria-label="Delete conversation"
        title="Delete"
        data-attr="admin-communication-delete-forever"
        onClick={() => void ctx.deleteForever()}
      >
        <Trash2 className="h-4 w-4" aria-hidden />
      </button>
    </>
  ) : stub ? null : (
    <button
      type="button"
      className={INBOX_THREAD_ICON_BTN}
      aria-label="Archive conversation"
      title="Archive"
      data-attr="admin-communication-move-to-trash"
      onClick={() => void ctx.archive()}
    >
      <Archive className="h-4 w-4" aria-hidden />
    </button>
  );

  return (
    <InboxThreadView
      title={title}
      subtitle={email || undefined}
      avatarName={title}
      messages={bubbles}
      threadKey={primary?.id}
      onBack={ctx.closeThread}
      headerActions={headerActions}
      underHeader={scheduledCards}
      emptyLabel="No messages in this conversation."
      composer={
        canReply ? (
          <InboxComposer
            value={draft}
            onChange={setDraft}
            onSubmit={() => void send()}
            sending={sending}
            placeholder="Write a reply…"
            dataAttr="admin-communication-reply"
            trailingControls={
              canSchedule ? (
                <InboxComposerScheduleMenu
                  scheduleLater={scheduleLater}
                  onScheduleLaterChange={setScheduleLater}
                  sendAt={scheduleSendAt}
                  onSendAtChange={setScheduleSendAt}
                />
              ) : undefined
            }
          />
        ) : undefined
      }
    />
  );
}

export function AdminThreadPane(ctx: InboxThreadPaneContext) {
  if (ctx.selection.channel === "sms") {
    return (
      <ManagerSmsPanel
        endpoint="/api/admin/sms-conversations"
        allowInlineCompose={false}
        allowDelete={false}
        allowArchive={false}
        suppressListPane
        controlledActiveId={ctx.selection.threadId}
        onControlledActiveIdChange={(id) => {
          if (!id) ctx.closeThread();
        }}
        onConversationOpened={ctx.onSmsConversationOpened}
        onProjectionStateChanged={ctx.onSmsProjectionStateChanged}
        smsUiEnabled={ctx.smsUiEnabled}
        listSegment={ctx.listSegment}
      />
    );
  }
  return <AdminEmailThread key={ctx.selection.threadId} {...ctx} />;
}
