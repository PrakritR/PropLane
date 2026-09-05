"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatPacificDateTime } from "@/lib/pacific-time";
import {
  MANAGER_SMS_TAB_DEFS,
  normalizeRoleSmsPayload,
  smsMessageBucket,
  type ManagerSmsBucketId,
  type ManagerSmsMessageRow,
  type RoleSmsConversationPayload,
} from "@/lib/manager-sms-messages";
import { isVoiceCallNoteSid } from "@/lib/voice/voice-call-notes";
import { PortalInboxEmptyState } from "@/components/portal/portal-inbox-ui";

const OPENED_STORAGE_PREFIX = "axis_role_sms_opened_";

function loadOpenedIds(storageKey: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string" && id.trim().length > 0));
  } catch {
    return new Set();
  }
}

function persistOpenedIds(storageKey: string, ids: Set<string>): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(storageKey, JSON.stringify([...ids]));
}

function SmsBubble({ msg }: { msg: ManagerSmsMessageRow }) {
  const inbound = msg.direction === "inbound";
  return (
    <div
      className={`max-w-[min(100%,36rem)] rounded-2xl px-3 py-2 text-sm ${
        inbound
          ? "mr-auto border border-border bg-accent/35 text-foreground"
          : "ml-auto border border-primary/25 bg-primary/10 text-foreground"
      }`}
    >
      <div className="mb-1 flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-muted">
        <span>{inbound ? "Inbound" : "Outbound"}</span>
        {isVoiceCallNoteSid(msg.messageSid) ? <span>Call</span> : null}
        <span className="ml-auto normal-case">{formatPacificDateTime(msg.createdAt)}</span>
      </div>
      <p className="whitespace-pre-wrap leading-relaxed">{msg.body || "—"}</p>
    </div>
  );
}

/** Resident/vendor Communication → SMS thread list with bucket filtering. */
export function RoleSmsPanel({
  apiPath,
  storageScope,
  tabId,
  onBucketCountsChange,
}: {
  apiPath: string;
  storageScope: string;
  tabId: ManagerSmsBucketId;
  onBucketCountsChange?: (counts: Record<ManagerSmsBucketId, number>) => void;
}) {
  const storageKey = `${OPENED_STORAGE_PREFIX}${storageScope}`;
  const [data, setData] = useState<RoleSmsConversationPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openedIds, setOpenedIds] = useState<Set<string>>(() => loadOpenedIds(storageKey));

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiPath, { credentials: "include", cache: "no-store" });
      const body = (await res.json()) as RoleSmsConversationPayload & { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not load SMS.");
      setData(normalizeRoleSmsPayload(body));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load SMS.");
    } finally {
      setLoading(false);
    }
  }, [apiPath]);

  useEffect(() => {
    void load();
  }, [load]);

  const messages = useMemo(() => data?.messages ?? [], [data?.messages]);

  const bucketedMessages = useMemo(() => {
    if (tabId === "schedule") return [];
    return [...messages]
      .filter((msg) => tabId === "all" || smsMessageBucket(msg, openedIds) === tabId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [messages, openedIds, tabId]);

  const bucketCounts = useMemo(() => {
    let unopened = 0;
    let opened = 0;
    let sent = 0;
    for (const msg of messages) {
      const bucket = smsMessageBucket(msg, openedIds);
      if (bucket === "sent") sent += 1;
      else if (bucket === "opened") opened += 1;
      else if (bucket === "unopened") unopened += 1;
    }
    return { all: messages.length, unopened, opened, schedule: 0, sent };
  }, [messages, openedIds]);

  useEffect(() => {
    onBucketCountsChange?.(bucketCounts);
  }, [bucketCounts, onBucketCountsChange]);

  const markOpened = useCallback(
    (messageId: string) => {
      setOpenedIds((prev) => {
        if (prev.has(messageId)) return prev;
        const next = new Set(prev);
        next.add(messageId);
        persistOpenedIds(storageKey, next);
        return next;
      });
    },
    [storageKey],
  );

  if (tabId === "schedule") {
    return <PortalInboxEmptyState title="No scheduled SMS yet." />;
  }

  if (loading) return <p className="text-sm text-muted">Loading texts…</p>;
  if (error) {
    return (
      <div className="rounded-xl border border-rose-200 bg-[var(--status-overdue-bg)] px-4 py-3 text-sm text-rose-900">
        {error}{" "}
        <button type="button" className="font-semibold underline" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }

  if (bucketedMessages.length === 0) {
    return <PortalInboxEmptyState title={tabId === "all" ? "No SMS yet." : `No ${tabId === "unopened" ? "unread" : tabId} SMS yet.`} />;
  }

  return (
    <div className="space-y-2">
      {bucketedMessages.map((msg) => (
        <button
          key={msg.id}
          type="button"
          className="block w-full text-left"
          onClick={() => {
            if (msg.direction === "inbound") markOpened(msg.id);
          }}
        >
          <SmsBubble msg={msg} />
        </button>
      ))}
    </div>
  );
}

export const RESIDENT_SMS_TAB_DEFS = MANAGER_SMS_TAB_DEFS;

export const VENDOR_SMS_TAB_DEFS = MANAGER_SMS_TAB_DEFS.filter((tab) => tab.id !== "schedule");
