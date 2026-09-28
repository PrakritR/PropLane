"use client";

/**
 * N087: the one feedback form, shared by every "Need help?" panel and every
 * profile Feedback pane (never a per-surface one-off — the interior.dev-style
 * motion and the submit contract live in exactly one place). A Type dropdown
 * (Bug / Idea / Question, a real {@link FieldSingleSelect} — never pills), a
 * single message, an optional screenshot, and the page the reporter was
 * standing on attached automatically — no separate Title field to fill in
 * first.
 *
 * `usePortalFeedbackForm` owns the state and the submit call; the caller
 * supplies presentation (a standalone {@link Modal} in
 * `PortalFeedbackSubmitModal`, or inline content inside a bigger panel in
 * `PortalHelpPanel`) and renders {@link PortalFeedbackFormBody} for the body
 * and {@link PortalFeedbackFormFooterButton} for the one footer action. Send
 * shows the shared Button's own loading state (its promise-tracking disables
 * double-submit for free); success swaps the body to a confirmation with a
 * plain fade/scale that stands down under `prefers-reduced-motion`
 * (`motion-reduce:animate-none`); a failed send stays on the form with an
 * inline retry.
 */

import { useEffect, useRef, useState } from "react";
import { Check, MonitorSmartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { MODAL_FIELD_LABEL_CLASS } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { track } from "@/lib/analytics/track-client";
import {
  reportTypeForKind,
  submitBugFeedbackReport,
  type BugFeedbackKind,
  type BugFeedbackReporterRole,
} from "@/lib/portal-bug-feedback";
import { BUG_FEEDBACK_MAX_ATTACHMENTS, uploadBugFeedbackImages } from "@/lib/bug-feedback-attachments";

export const FEEDBACK_KIND_OPTIONS: { value: BugFeedbackKind; label: string }[] = [
  { value: "bug", label: "Bug" },
  { value: "idea", label: "Idea" },
  { value: "question", label: "Question" },
];

/** A plain message becomes the admin-facing title, capped rather than doubled up with a separate field. */
function deriveFeedbackTitle(message: string): string {
  const trimmed = message.trim().replace(/\s+/g, " ");
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed;
}

export function usePortalFeedbackForm({
  reporterRole,
  reporterUserId,
  reporterEmail,
  reporterName,
  onSubmitted,
  initialMessage = "",
  initialKind = "bug",
  open,
}: {
  reporterRole: BugFeedbackReporterRole;
  reporterUserId: string | null;
  reporterEmail: string;
  reporterName: string;
  onSubmitted: () => void | Promise<void>;
  /** Pre-filled message (e.g. the in-app rating sheet's "Rated 2/5 in the app"). Empty for every ordinary caller. */
  initialMessage?: string;
  /** Pre-selected Type. Defaults to the first option (Bug). */
  initialKind?: BugFeedbackKind;
  /** Whether the surface showing this form is currently open — gates capturing the page context. */
  open: boolean;
}) {
  const { showToast } = useAppUi();
  const [kind, setKind] = useState<BugFeedbackKind>(initialKind);
  const [message, setMessage] = useState(initialMessage);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [pageContext, setPageContext] = useState("");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The page the report was filed from — captured silently when the surface
  // opens, never a field the reporter edits.
  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    setPageContext(window.location.pathname + window.location.search);
  }, [open]);

  const resetForm = () => {
    setKind(initialKind);
    setMessage(initialMessage);
    setAttachments([]);
    setSubmitError(null);
    setSubmitted(false);
  };

  const addAttachments = (picked: File[]) => {
    if (picked.length === 0) return;
    setAttachments((prev) => {
      const room = BUG_FEEDBACK_MAX_ATTACHMENTS - prev.length;
      if (room <= 0) {
        showToast(`You can attach up to ${BUG_FEEDBACK_MAX_ATTACHMENTS} images.`);
        return prev;
      }
      const next = [...prev, ...picked.slice(0, room)];
      if (picked.length > room) {
        showToast(`Only ${BUG_FEEDBACK_MAX_ATTACHMENTS} images allowed. Extra files were skipped.`);
      }
      return next;
    });
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async () => {
    const userId = reporterUserId;
    const email = reporterEmail.trim();
    if (!userId || !email.includes("@")) {
      showToast("Sign in to submit feedback.");
      return;
    }
    const trimmed = message.trim();
    if (!trimmed) {
      showToast("Tell us what's on your mind.");
      return;
    }
    setSubmitError(null);
    setBusy(true);
    try {
      const attachmentUrls = attachments.length > 0 ? await uploadBugFeedbackImages(attachments) : undefined;
      await submitBugFeedbackReport({
        type: reportTypeForKind(kind),
        reportKind: kind,
        reporterUserId: userId,
        reporterName: reporterName.trim() || email,
        reporterEmail: email,
        reporterRole,
        title: deriveFeedbackTitle(trimmed),
        description: trimmed,
        pageUrl: pageContext || undefined,
        attachmentUrls,
      });
      track("feedback_submitted", { role: reporterRole, kind });
      if (!mountedRef.current) return;
      setSubmitted(true);
      await onSubmitted();
    } catch {
      if (mountedRef.current) setSubmitError("Could not send. Check your connection and try again.");
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  return {
    kind,
    setKind,
    message,
    setMessage,
    attachments,
    addAttachments,
    removeAttachment,
    busy,
    submitError,
    submitted,
    pageContext,
    handleSubmit,
    resetForm,
  };
}

export type PortalFeedbackFormState = ReturnType<typeof usePortalFeedbackForm>;

/** The form body, or — once sent — the success confirmation in its place. */
export function PortalFeedbackFormBody({ form }: { form: PortalFeedbackFormState }) {
  const atAttachmentLimit = form.attachments.length >= BUG_FEEDBACK_MAX_ATTACHMENTS;

  if (form.submitted) {
    return (
      <div
        className="flex flex-col items-center gap-3 py-6 text-center animate-in fade-in zoom-in-95 duration-300 motion-reduce:animate-none"
        data-attr="feedback-success"
      >
        <span className="portal-badge-success grid h-12 w-12 place-items-center rounded-full">
          <Check className="h-6 w-6" aria-hidden />
        </span>
        <div>
          <p className="text-sm font-semibold text-foreground">Thanks — we got it.</p>
          <p className="mt-1 text-sm text-muted">Our team reads every report that comes in.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <FieldSingleSelect
        label="Type"
        value={form.kind}
        options={FEEDBACK_KIND_OPTIONS}
        onChange={(next) => form.setKind(next as BugFeedbackKind)}
        disabled={form.busy}
        dataAttr="feedback-type"
      />
      <div>
        <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="feedback-message">
          Message
        </label>
        <Textarea
          id="feedback-message"
          className="mt-1.5 min-h-[120px]"
          rows={5}
          value={form.message}
          disabled={form.busy}
          onChange={(e) => form.setMessage(e.target.value)}
          placeholder="What would help you, or what went wrong? Include steps if something is broken."
          data-attr="feedback-message"
        />
      </div>
      <div>
        <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="feedback-attachments">
          Screenshot (optional, up to {BUG_FEEDBACK_MAX_ATTACHMENTS})
        </label>
        <input
          id="feedback-attachments"
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          multiple
          disabled={atAttachmentLimit || form.busy}
          className="mt-1.5 block w-full text-xs text-muted file:mr-3 file:rounded-full file:border-0 file:bg-accent/50 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-foreground disabled:opacity-50"
          onChange={(e) => {
            form.addAttachments(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        {form.attachments.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {form.attachments.map((file, index) => (
              <span
                key={`${file.name}-${file.lastModified}`}
                className="inline-flex items-center gap-1 rounded-full bg-accent/30 py-0.5 pl-2 pr-1 text-[10px] text-muted"
              >
                {file.name}
                <button
                  type="button"
                  className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold text-muted hover:bg-accent/50 hover:text-foreground"
                  onClick={() => form.removeAttachment(index)}
                  aria-label={`Remove ${file.name}`}
                  disabled={form.busy}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {form.pageContext ? (
        <div>
          <p className={MODAL_FIELD_LABEL_CLASS}>Page</p>
          <p className="mt-1.5 flex items-center gap-1.5 truncate text-sm text-muted" title={form.pageContext}>
            <MonitorSmartphone className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="truncate">{form.pageContext}</span>
          </p>
        </div>
      ) : null}
      {form.submitError ? (
        <p className="text-sm text-danger" role="alert" data-attr="feedback-error">
          {form.submitError}
        </p>
      ) : null}
    </div>
  );
}

/** The one footer action: Send (busy/retry labels folded in) until sent, then Done. */
export function PortalFeedbackFormFooterButton({
  form,
  onDone,
}: {
  form: PortalFeedbackFormState;
  onDone: () => void;
}) {
  if (form.submitted) {
    return (
      <Button type="button" variant="outline" className="rounded-full" onClick={onDone} data-attr="feedback-done">
        Done
      </Button>
    );
  }
  return (
    <Button
      type="button"
      variant="primary"
      className="rounded-full"
      disabled={form.busy}
      onClick={() => form.handleSubmit()}
      data-attr="feedback-send"
    >
      {form.busy ? "Sending…" : form.submitError ? "Try again" : "Send"}
    </Button>
  );
}
