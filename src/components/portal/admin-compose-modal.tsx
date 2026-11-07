"use client";

/**
 * Admin's New message compose: pick an audience (everyone, all managers, all
 * residents, or specific people), write the message, send now or schedule it.
 *
 * It is the one place admin chooses recipients, so it keeps the recipient
 * picker and "Schedule for later" the old admin inbox had. Mounted by the
 * round + on the admin Communication page (`admin-communication.tsx`).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { PopupMessagePreview, PopupRecordPreview } from "@/components/portal/popup-live-preview";
import { PortalDialog } from "@/components/portal/portal-dialog";
import {
  PortalMessageBodyField,
  PortalMessageComposeModalBody,
  PortalMessageScheduleFields,
  PortalMessageSubjectField,
  portalMessageFieldLabel,
} from "@/components/portal/portal-message-compose-fields";
import { adminOversightUrl } from "@/lib/auth/admin-oversight.client";
import { Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { appendInboxMessage, type AdminComposeSendMode } from "@/lib/demo-admin-partner-inbox";

const ADMIN_COMPOSE_MODE_OPTIONS: { value: AdminComposeSendMode; label: string }[] = [
  { value: "all_portal", label: "Everyone (managers & residents)" },
  { value: "all_managers", label: "All managers" },
  { value: "all_residents", label: "All residents" },
  { value: "pick_managers", label: "Choose managers…" },
  { value: "pick_residents", label: "Choose residents…" },
];

export type AdminComposeRecipient = { id: string; name: string; email: string };

function defaultScheduleAtLocal(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function AdminComposeModal({
  open,
  onClose,
  onSent,
  recipients,
  initialSchedule,
  recipientsStatus = "ready",
  onRetryRecipients,
}: {
  open: boolean;
  onClose: () => void;
  onSent: () => void;
  recipients: { managers: AdminComposeRecipient[]; residents: AdminComposeRecipient[] };
  recipientsStatus?: "loading" | "ready" | "error";
  onRetryRecipients?: () => void;
  /** Open pre-set to "Schedule for later". */
  initialSchedule?: boolean;
}) {
  const { showToast } = useAppUi();
  const [mode, setMode] = useState<AdminComposeSendMode>("pick_managers");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [topic, setTopic] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [sendMode, setSendMode] = useState<"now" | "schedule">("now");
  const [sendAtLocal, setSendAtLocal] = useState(defaultScheduleAtLocal());
  const wasOpen = useRef(false);
  const submittingRef = useRef(false);
  const composeSession = useRef(0);

  const pickPool = useMemo(() => {
    const pool = mode === "pick_managers" ? recipients.managers : mode === "pick_residents" ? recipients.residents : [];
    return [...new Map(pool.map((person) => [person.id, person])).values()];
  }, [mode, recipients]);

  useEffect(() => {
    if (!open) {
      if (wasOpen.current) composeSession.current += 1;
      wasOpen.current = false;
      return;
    }
    if (wasOpen.current) return;
    wasOpen.current = true;
    const session = ++composeSession.current;
    queueMicrotask(() => {
      if (composeSession.current !== session) return;
      setTopic("");
      setBody("");
      setMode("pick_managers");
      const first = recipients.managers[0]?.id;
      setSelectedIds(first ? new Set([first]) : new Set());
      setSendMode(initialSchedule ? "schedule" : "now");
      setSendAtLocal(defaultScheduleAtLocal());
    });
  }, [open, recipients.managers, initialSchedule]);

  useEffect(() => {
    if (!open || mode !== "pick_managers") return;
    const first = recipients.managers[0]?.id;
    if (!first) return;
    queueMicrotask(() => setSelectedIds((current) => current.size > 0 ? current : new Set([first])));
  }, [open, mode, recipients.managers]);

  const toggleId = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const pickHeading =
    mode === "pick_managers" ? "Which managers" : mode === "pick_residents" ? "Which residents" : null;

  const resolvePicked = (): AdminComposeRecipient[] => {
    const pool = mode === "all_portal" ? [...recipients.managers, ...recipients.residents]
      : mode === "all_managers" || mode === "pick_managers" ? recipients.managers : recipients.residents;
    if (pool.some((person) => !person || !person.id?.trim() || !person.name?.trim() || !person.email?.trim())) return [];
    // A selection that disappeared from the current directory must be re-picked.
    if (mode.startsWith("pick") && [...selectedIds].some((id) => !pool.some((person) => person.id === id))) return [];
    return [...new Map(pool.filter((person) => !mode.startsWith("pick") || selectedIds.has(person.id))
      .map((person) => [person.id, person])).values()];
  };

  const submitSendNow = async (topicTrim: string, bodyTrim: string) => {
    const picked = resolvePicked();
    if (picked.length === 0) return false;
    const broadcast = !mode.startsWith("pick");
    const roleLabel = mode === "pick_managers" ? "Manager" : "Resident";
    const label = mode === "all_portal" ? "All managers & residents" : mode === "all_managers" ? "All managers" : "All residents";
    const message: Parameters<typeof appendInboxMessage>[0] = {
      name: broadcast ? "Broadcast" : picked.length === 1 ? picked[0]!.name : `${picked.length} recipients`,
      email: broadcast ? mode === "all_portal" ? "all-portal@axis.local" : mode === "all_managers" ? "all-managers@axis.local" : "all-residents@axis.local" : picked.map((person) => person.email).join("; "),
      topic: topicTrim,
      body: bodyTrim,
      folder: "sent",
      senderRole: "admin",
      composeAudience: broadcast ? mode === "all_portal" ? "all" : mode === "all_managers" ? "all_managers" : "all_residents" : picked.length > 1 ? "multi" : mode === "pick_managers" ? "manager" : "resident",
      composeRecipientLabel: broadcast ? label : picked.length === 1 ? `${picked[0]!.name} (${roleLabel})` : `${picked.length} ${roleLabel.toLowerCase()}s (${picked.map((person) => person.name).join(", ")})`,
    };
    try {
      const response = await fetch(adminOversightUrl("/api/portal/send-inbox-message"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          fromName: "PropLane Admin",
          toUserIds: picked.map((person) => person.id),
          subject: topicTrim,
          text: bodyTrim,
          deliverViaEmail: false,
          senderPortal: "manager",
        }),
      });
      const result = await response.json() as { ok?: boolean } | null;
      if (!response.ok || result?.ok !== true) throw new Error("Send refused");
    } catch {
      showToast("Message could not be sent.");
      return false;
    }
    appendInboxMessage(message);
    showToast("Message sent. It appears under Sent.");
    return true;
  };

  const submitSchedule = async (topicTrim: string, bodyTrim: string) => {
    const sendAt = new Date(sendAtLocal);
    if (Number.isNaN(sendAt.getTime())) {
      showToast("Choose a valid send date and time.");
      return false;
    }
    if (sendAt.getTime() < Date.now() - 60_000) {
      showToast("Send time must be in the future.");
      return false;
    }
    const picked = resolvePicked();
    if (picked.length === 0) {
      showToast("Select at least one recipient.");
      return false;
    }

    const results = await Promise.all(
      picked.map((p) =>
        fetch(adminOversightUrl("/api/portal/scheduled-inbox-messages"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            subject: topicTrim,
            body: bodyTrim,
            sendAt: sendAt.toISOString(),
            recipientEmail: p.email,
            recipientName: p.name,
            recipientUserId: p.id,
            deliverViaEmail: false,
          }),
        })
          .then((res) => res.ok)
          .catch(() => false),
      ),
    );
    if (results.some((ok) => !ok)) {
      showToast("Some recipients could not be scheduled.");
      return false;
    }

    showToast(
      picked.length === 1 ? "Message scheduled." : `Message scheduled for ${picked.length} recipients.`,
    );
    return true;
  };

  const submit = async () => {
    if (submittingRef.current) return;
    if (recipientsStatus !== "ready") {
      showToast("Recipients are not ready.");
      return;
    }
    if (resolvePicked().length === 0) {
      showToast("Select at least one recipient.");
      return;
    }

    const topicTrim = topic.trim();
    const bodyTrim = body.trim();
    if (!topicTrim || !bodyTrim) {
      showToast("Add a subject and message.");
      return;
    }

    const session = composeSession.current;
    submittingRef.current = true;
    setBusy(true);
    try {
      const ok =
        sendMode === "schedule" ? await submitSchedule(topicTrim, bodyTrim) : await submitSendNow(topicTrim, bodyTrim);
      if (!ok) return;
      onSent();
      // An accepted send still refreshes Sent, but owns only its original draft.
      if (wasOpen.current && composeSession.current === session) onClose();
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  };

  const recipientSummary =
    pickPool.filter((person) => selectedIds.has(person.id)).map((person) => person.name).join(", ") ||
    ADMIN_COMPOSE_MODE_OPTIONS.find((option) => option.value === mode)?.label;

  // Same dialog, same field order and same field chrome as every New message
  // (see docs/agents/send-message-compose.md). What stays admin's own is the
  // audience (everyone / all managers / chosen people), because admin messages
  // groups and the manager To field picks individuals.
  return (
    <PortalDialog
      open={open}
      onClose={() => {
        composeSession.current += 1;
        onClose();
      }}
      title={initialSchedule ? "Schedule message" : "New message"}
      contextPanel={<PopupRecordPreview rows={[{ label: "Audience", value: ADMIN_COMPOSE_MODE_OPTIONS.find((option) => option.value === mode)?.label }, { label: "Recipients", value: recipientSummary }]} />}
      previewLabel="Message preview"
      preview={<PopupMessagePreview subject={topic} body={body} recipient={recipientSummary} sendAt={sendMode === "schedule" ? sendAtLocal : undefined} />}
      secondaryAction={null}
      primaryAction={{
        label: sendMode === "schedule" ? "Schedule" : "Send message",
        onClick: () => submit(),
        disabled: busy || recipientsStatus !== "ready" || resolvePicked().length === 0,
        loading: busy,
        dataAttr: "admin-compose-send",
      }}
    >
      <PortalMessageComposeModalBody>
        {recipientsStatus === "loading" ? <span role="status">Loading recipients…</span> : null}
        {recipientsStatus === "error" ? <Button type="button" variant="ghost" onClick={onRetryRecipients}>Retry recipients</Button> : null}
        <div>
          <label className={portalMessageFieldLabel()} htmlFor="admin-compose-audience">To</label>
          <Select
            id="admin-compose-audience"
            className="mt-1"
            value={mode}
            onChange={(e) => {
              const v = e.target.value as AdminComposeSendMode;
              setMode(v);
              if (v === "pick_managers") {
                const first = recipients.managers[0]?.id;
                setSelectedIds(first ? new Set([first]) : new Set());
              } else if (v === "pick_residents") {
                const first = recipients.residents[0]?.id;
                setSelectedIds(first ? new Set([first]) : new Set());
              } else {
                setSelectedIds(new Set());
              }
            }}
            aria-label="Recipient type"
          >
            {ADMIN_COMPOSE_MODE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>

        {pickHeading && pickPool.length > 0 ? (
          <div className="rounded-xl border border-border bg-accent/30 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className={portalMessageFieldLabel()}>{pickHeading}</span>
              <button
                type="button"
                className="text-xs font-semibold text-primary hover:underline"
                onClick={() => setSelectedIds(new Set(pickPool.map((p) => p.id)))}
              >
                Select all
              </button>
            </div>
            <ul className="mt-2 max-h-40 space-y-2 overflow-y-auto pr-1">
              {pickPool.map((c) => (
                <li key={c.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-lg bg-card px-2 py-2 text-sm ring-1 ring-border hover:bg-accent/30">
                    <input
                      type="checkbox"
                      className="h-4 w-4 shrink-0 rounded border-border accent-primary"
                      checked={selectedIds.has(c.id)}
                      onChange={() => toggleId(c.id)}
                    />
                    <span className="min-w-0 truncate" title={c.email}>
                      <span className="font-medium text-foreground">{c.name}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <PortalMessageSubjectField id="admin-compose-subject" value={topic} onChange={setTopic} />
        <PortalMessageBodyField id="admin-compose-body" value={body} onChange={setBody} />
        <PortalMessageScheduleFields
          scheduleLater={sendMode === "schedule"}
          onScheduleLaterChange={(next) => setSendMode(next ? "schedule" : "now")}
          sendAt={sendAtLocal}
          onSendAtChange={setSendAtLocal}
          disabled={busy}
          scheduleDataAttr="admin-compose-schedule-later"
          sendAtDataAttr="admin-compose-schedule-at"
        />
      </PortalMessageComposeModalBody>
    </PortalDialog>
  );
}
