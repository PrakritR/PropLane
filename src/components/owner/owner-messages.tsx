"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useOwnerFetch } from "@/components/owner/owner-data";
import { OwnerEmpty, OwnerError, OwnerLoading, OwnerPageTitle } from "@/components/owner/owner-ui";
import type { OwnerConversation } from "@/lib/property-owner/projection";
import { cn } from "@/lib/utils";

/** Messages — only your own conversation with your manager, and only while it is on for you. */
export function OwnerMessagesPage() {
  const { showToast } = useAppUi();
  const { data, loading, error, reload } = useOwnerFetch<{ conversations: OwnerConversation[] }>("/api/owner/messages");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const send = async (conversationId: string) => {
    const body = (drafts[conversationId] ?? "").trim();
    if (!body || busy) return;
    setBusy(conversationId);
    try {
      const res = await fetch("/api/owner/messages", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, body }),
      });
      const out = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(out.error ?? "Could not send your message.");
      setDrafts((cur) => ({ ...cur, [conversationId]: "" }));
      reload();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not send your message.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-attr="owner-messages">
      <OwnerPageTitle>Messages</OwnerPageTitle>
      {loading && !data ? (
        <OwnerLoading />
      ) : error ? (
        <OwnerError message="Couldn't load your messages." onRetry={reload} />
      ) : !data || data.conversations.length === 0 ? (
        <OwnerEmpty title="No messages yet" />
      ) : (
        data.conversations.map((conversation) => (
          <div key={conversation.conversationId} className="rounded-2xl border border-border bg-card p-4">
            <div className="flex max-h-[28rem] flex-col gap-2 overflow-y-auto" data-attr="owner-thread">
              {conversation.messages.length === 0 ? (
                <p className="py-6 text-center text-sm font-medium text-foreground">No messages yet</p>
              ) : (
                conversation.messages.map((m) => (
                  <div
                    key={m.id || m.at}
                    className={cn(
                      "max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm",
                      m.fromMe ? "ml-auto bg-primary text-white" : "mr-auto bg-accent text-foreground",
                    )}
                  >
                    {m.body}
                  </div>
                ))
              )}
            </div>
            <form
              className="mt-3 flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void send(conversation.conversationId);
              }}
            >
              <Input
                aria-label="Message"
                value={drafts[conversation.conversationId] ?? ""}
                onChange={(e) => setDrafts((cur) => ({ ...cur, [conversation.conversationId]: e.target.value }))}
                maxLength={4000}
                data-attr="owner-message-input"
              />
              <Button type="submit" loading={busy === conversation.conversationId} data-attr="owner-message-send">
                Send
              </Button>
            </form>
          </div>
        ))
      )}
    </div>
  );
}
