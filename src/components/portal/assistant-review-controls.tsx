"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Flag, Hand, PauseCircle, Pencil, PlayCircle } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { Button } from "@/components/ui/button";
import { fetchWithTimeout, PORTAL_READ_TIMEOUT_MS } from "@/lib/auth/fetch-with-timeout";
import {
  REVIEW_CORRECTION_MAX,
  REVIEW_REASON_MAX,
  emptyReviewState,
  reviewMarksFor,
  type ThreadReviewState,
} from "@/lib/assistant-review/model";

/**
 * Assistant quality management on one conversation (manager Communication and admin Communication).
 *
 * `AssistantReviewProvider` reads the conversation's state once; the thread header draws `AssistantThreadControls`
 * (Pause / Resume, Take over) and each assistant turn draws `AssistantReplyReview` (Flag, Correct). Everything is absent
 * while the state cannot be read (a refused or unavailable read means the feature does not exist for this thread).
 * Icon chrome only: the words are tooltips, and the one labeled control is the commit (Save).
 */
export type AssistantReviewScope = { kind: "manager" } | { kind: "admin"; workspaceId: string };

type Ctx = {
  state: ThreadReviewState;
  threadKey: string;
  role: string | null;
  scope: AssistantReviewScope;
  busy: boolean;
  post: (body: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
};

const ReviewContext = createContext<Ctx | null>(null);

function endpointFor(scope: AssistantReviewScope): string {
  return scope.kind === "admin" ? "/api/admin/assistant-review" : "/api/portal/assistant-review";
}

export function AssistantReviewProvider({
  threadKey,
  scope,
  role = null,
  children,
}: {
  /** The conversation id, `sms:<phone key>` or its conversation key. Null = nothing to review (no provider state). */
  threadKey: string | null | undefined;
  scope: AssistantReviewScope;
  /** The counterparty's role; keeps a text thread's pause projected under the right role. */
  role?: string | null;
  children: ReactNode;
}) {
  const [state, setState] = useState<ThreadReviewState | null>(null);
  const [busy, setBusy] = useState(false);
  const endpoint = endpointFor(scope);
  const adminWorkspaceId = scope.kind === "admin" ? scope.workspaceId : "";

  useEffect(() => {
    setState(null);
    if (!threadKey) return;
    let cancelled = false;
    void (async () => {
      try {
        const q = new URLSearchParams({ threadKey });
        if (adminWorkspaceId) q.set("workspaceId", adminWorkspaceId);
        const res = await fetchWithTimeout(`${endpoint}?${q.toString()}`, { credentials: "include", cache: "no-store" }, PORTAL_READ_TIMEOUT_MS);
        if (!res.ok) return;
        const body = (await res.json().catch(() => null)) as ThreadReviewState | null;
        if (!cancelled && body && typeof body.paused === "boolean") setState({ ...emptyReviewState(), ...body });
      } catch {
        /* absent for this thread */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [threadKey, endpoint, adminWorkspaceId]);

  const post = useCallback(
    async (payload: Record<string, unknown>) => {
      if (!threadKey) return { ok: false, error: "No conversation." };
      setBusy(true);
      try {
        const res = await fetchWithTimeout(
          endpoint,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ threadKey, role, ...(adminWorkspaceId ? { workspaceId: adminWorkspaceId } : {}), ...payload }),
          },
          PORTAL_READ_TIMEOUT_MS,
        );
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        if (!res.ok) return { ok: false, error: body?.error || "Could not save that." };
        // Re-read: the server is the one place the new state is known.
        const q = new URLSearchParams({ threadKey });
        if (adminWorkspaceId) q.set("workspaceId", adminWorkspaceId);
        const fresh = await fetchWithTimeout(`${endpoint}?${q.toString()}`, { credentials: "include", cache: "no-store" }, PORTAL_READ_TIMEOUT_MS);
        if (fresh.ok) setState({ ...emptyReviewState(), ...((await fresh.json()) as ThreadReviewState) });
        return { ok: true };
      } catch {
        return { ok: false, error: "Could not save that." };
      } finally {
        setBusy(false);
      }
    },
    [threadKey, endpoint, adminWorkspaceId, role],
  );

  const value = useMemo<Ctx | null>(
    () => (threadKey && state ? { state, threadKey, role, scope, busy, post } : null),
    [threadKey, state, role, scope, busy, post],
  );
  return <ReviewContext.Provider value={value}>{children}</ReviewContext.Provider>;
}

export function useAssistantReview(): Ctx | null {
  return useContext(ReviewContext);
}

/** Pause / Resume assistant, and Take over (pauses, then focuses the composer). Renders nothing without review state. */
export function AssistantThreadControls({ composerSelector = '[data-attr="sms-messages-reply"]' }: { composerSelector?: string }) {
  const review = useAssistantReview();
  if (!review) return null;
  const { state, busy, post } = review;
  const focusComposer = () => {
    const el = document.querySelector<HTMLElement>(composerSelector);
    el?.focus();
  };
  return (
    <>
      <PortalIconAction
        icon={state.paused ? PlayCircle : PauseCircle}
        label={state.paused ? "Resume assistant" : "Pause assistant on this conversation"}
        disabled={busy}
        data-attr={state.paused ? "thread-assistant-resume" : "thread-assistant-pause"}
        onClick={() => void post({ action: state.paused ? "resume" : "pause" })}
      />
      {state.paused ? null : (
        <PortalIconAction
          icon={Hand}
          label="Take over"
          disabled={busy}
          data-attr="thread-assistant-takeover"
          onClick={() => void post({ action: "takeover" }).then((r) => (r.ok ? focusComposer() : undefined))}
        />
      )}
    </>
  );
}

type Mode = null | "flag" | "correct";

/** Under an assistant turn: Flag (with a reason) and Correct (what the answer should have been). */
export function AssistantReplyReview({
  messageRef,
  agentText,
  askedText = "",
  propertyId = null,
  audience = "residents",
}: {
  messageRef: string;
  agentText: string;
  /** What the person asked just before this reply; becomes the question the correction answers. */
  askedText?: string;
  propertyId?: string | null;
  audience?: "all" | "residents" | "team";
}) {
  const review = useAssistantReview();
  const [mode, setMode] = useState<Mode>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!review || !messageRef) return null;
  const marks = reviewMarksFor(review.state, messageRef);
  const submit = async () => {
    setError(null);
    const out =
      mode === "flag"
        ? await review.post({ action: "flag", messageRef, reason: text, agentText })
        : await review.post({ action: "correct", messageRef, correction: text, question: askedText, agentText, propertyId, audience });
    if (!out.ok) {
      setError(out.error ?? "Could not save that.");
      return;
    }
    setText("");
    setMode(null);
  };
  return (
    <div className="mt-1" data-assistant-review={messageRef}>
      <div className="flex items-center gap-0.5 text-[11.5px] text-muted/80">
        <PortalIconAction icon={Flag} label="Flag this reply" data-attr="assistant-reply-flag" active={mode === "flag" || marks.flagged} onClick={() => { setError(null); setMode(mode === "flag" ? null : "flag"); }} />
        <PortalIconAction icon={Pencil} label="Correct this reply" data-attr="assistant-reply-correct" active={mode === "correct" || marks.corrected} onClick={() => { setError(null); setMode(mode === "correct" ? null : "correct"); }} />
        {marks.flagged ? <span data-assistant-flagged>Flagged</span> : null}
        {marks.corrected ? <span data-assistant-corrected>Corrected</span> : null}
      </div>
      {mode ? (
        <div className="mt-1 flex max-w-xl flex-col gap-1.5">
          <textarea
            className="min-h-16 w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm text-foreground"
            value={text}
            maxLength={mode === "flag" ? REVIEW_REASON_MAX : REVIEW_CORRECTION_MAX}
            onChange={(event) => setText(event.target.value)}
            placeholder={mode === "flag" ? "What was wrong with this reply" : "What the answer should have been"}
            aria-label={mode === "flag" ? "Reason" : "Correct answer"}
            data-attr={mode === "flag" ? "assistant-reply-flag-reason" : "assistant-reply-correct-body"}
          />
          {error ? <p className="text-xs text-danger" role="alert">{error}</p> : null}
          <div className="flex items-center gap-2">
            <Button variant="primary" disabled={!text.trim() || review.busy} onClick={() => submit()}>
              Save
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
