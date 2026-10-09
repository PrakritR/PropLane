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
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { MODAL_LARGE_PANEL_CLASS } from "@/components/ui/modal-styles";
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
}: {
  open: boolean;
  onClose: () => void;
  onSent: () => void;
  recipients: { managers: AdminComposeRecipient[]; residents: AdminComposeRecipient[] };
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

  const pickPool = useMemo(() => {
    if (mode === "pick_managers") return recipients.managers;
    if (mode === "pick_residents") return recipients.residents;
    return [] as AdminComposeRecipient[];
  }, [mode, recipients]);

  useEffect(() => {
    if (!open) {
      wasOpen.current = false;
      return;
    }
    if (wasOpen.current) return;
    wasOpen.current = true;
    queueMicrotask(() => {
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
    if (mode === "all_portal") return [...recipients.managers, ...recipients.residents];
    if (mode === "all_managers") return recipients.managers;
    if (mode === "all_residents") return recipients.residents;
    const pool = mode === "pick_managers" ? recipients.managers : recipients.residents;
    return pool.filter((p) => selectedIds.has(p.id));
  };

  const submitSendNow = (topicTrim: string, bodyTrim: string) => {
    let toUserIds: string[] = [];

    if (mode === "all_portal" || mode === "all_managers" || mode === "all_residents") {
      const label =
        mode === "all_portal"
          ? "All managers & residents"
          : mode === "all_managers"
            ? "All managers"
            : "All residents";
      const emailStub =
        mode === "all_portal"
          ? "all-portal@axis.local"
          : mode === "all_managers"
            ? "all-managers@axis.local"
            : "all-residents@axis.local";
      appendInboxMessage({
        name: "Broadcast",
        email: emailStub,
        topic: topicTrim,
        body: bodyTrim,
        folder: "sent",
        senderRole: "admin",
        composeAudience: mode === "all_portal" ? "all" : mode,
        composeRecipientLabel: label,
      });
      toUserIds = resolvePicked().map((p) => p.id);
    } else {
      const picked = resolvePicked();
      if (picked.length === 0) {
        showToast("Select at least one recipient.");
        return false;
      }
      const roleLabel = mode === "pick_managers" ? "Manager" : "Resident";
      appendInboxMessage({
        name: picked.length === 1 ? picked[0]!.name : `${picked.length} recipients`,
        email: picked.map((p) => p.email).filter(Boolean).join("; "),
        topic: topicTrim,
        body: bodyTrim,
        folder: "sent",
        senderRole: "admin",
        composeAudience: picked.length > 1 ? "multi" : mode === "pick_managers" ? "manager" : "resident",
        composeRecipientLabel:
          picked.length === 1
            ? `${picked[0]!.name} (${roleLabel})`
            : `${picked.length} ${roleLabel.toLowerCase()}s (${picked.map((p) => p.name).join(", ")})`,
      });
      toUserIds = picked.map((p) => p.id);
    }

    // Deliver to each recipient's real portal inbox (admin's own "Sent" record above is separate).
    if (toUserIds.length > 0) {
      void fetch("/api/portal/send-inbox-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          fromName: "PropLane Admin",
          toUserIds,
          subject: topicTrim,
          text: bodyTrim,
          deliverViaEmail: false,
          senderPortal: "manager",
        }),
      }).catch(() => undefined);
    }

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
        fetch("/api/portal/scheduled-inbox-messages", {
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
    const isPick = mode.startsWith("pick");
    if (isPick && selectedIds.size === 0) {
      showToast("Select at least one recipient.");
      return;
    }

    const topicTrim = topic.trim();
    const bodyTrim = body.trim();
    if (!topicTrim || !bodyTrim) {
      showToast("Add a subject and message.");
      return;
    }

    setBusy(true);
    try {
      const ok =
        sendMode === "schedule" ? await submitSchedule(topicTrim, bodyTrim) : submitSendNow(topicTrim, bodyTrim);
      if (!ok) return;
      onSent();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={initialSchedule ? "Schedule message" : "New message"}
      contextPanel={<PopupRecordPreview rows={[{ label: "Audience", value: ADMIN_COMPOSE_MODE_OPTIONS.find(option => option.value === mode)?.label }, { label: "Recipients", value: pickPool.filter(person => selectedIds.has(person.id)).map(person => person.name).join(", ") || ADMIN_COMPOSE_MODE_OPTIONS.find(option => option.value === mode)?.label }]} />}
      previewLabel="Message preview"
      preview={<PopupMessagePreview subject={topic} body={body} recipient={pickPool.filter(person => selectedIds.has(person.id)).map(person => person.name).join(", ") || ADMIN_COMPOSE_MODE_OPTIONS.find(option => option.value === mode)?.label} sendAt={sendMode === "schedule" ? sendAtLocal : undefined} />}
      panelClassName={MODAL_LARGE_PANEL_CLASS}
      footer={
        <ModalFooter>
          <Button type="button" className="rounded-full" onClick={() => submit()} disabled={busy}>
            {busy ? "Sending…" : sendMode === "schedule" ? "Schedule" : "Send"}
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-3">
          <div>
            <label className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">Send to</label>
            <Select
              className="mt-1.5"
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
                <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">{pickHeading}</span>
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
                    <label className="flex cursor-pointer items-start gap-2 rounded-lg bg-card px-2 py-2 text-sm ring-1 ring-border hover:bg-accent/30">
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 shrink-0 rounded border-border"
                        checked={selectedIds.has(c.id)}
                        onChange={() => toggleId(c.id)}
                      />
                      <span>
                        <span className="font-medium text-foreground">{c.name}</span>
                        <span className="mt-0.5 block text-xs text-muted">{c.email}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div>
            <label className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">Subject</label>
            <Input className="mt-1.5" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Subject" />
          </div>

          <div>
            <label className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">Message</label>
            <Textarea
              className="mt-1.5 min-h-[140px]"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your message…"
            />
          </div>

          <div>
            <label className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">When</label>
            <div className="mt-1.5 flex gap-2">
              <button
                type="button"
                className={`flex-1 rounded-xl border px-3 py-2 text-sm font-medium ${sendMode === "now" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted"}`}
                onClick={() => setSendMode("now")}
                disabled={busy}
              >
                Send now
              </button>
              <button
                type="button"
                className={`flex-1 rounded-xl border px-3 py-2 text-sm font-medium ${sendMode === "schedule" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted"}`}
                onClick={() => setSendMode("schedule")}
                disabled={busy}
              >
                Schedule for later
              </button>
            </div>
            {sendMode === "schedule" ? (
              <Input
                type="datetime-local"
                className="mt-2"
                value={sendAtLocal}
                onChange={(e) => setSendAtLocal(e.target.value)}
                disabled={busy}
              />
            ) : null}
          </div>
        </div>
    </Modal>
  );
}

