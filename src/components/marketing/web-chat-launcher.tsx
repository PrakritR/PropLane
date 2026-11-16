"use client";

/**
 * Quick chat on a listing page (captain, Nov 15): the first thing a visitor can do. No account, no phone code and no app to
 * start; they type and the PropLane assistant answers exactly as it would by text, and the manager reads and answers the same
 * conversation in Communication. A compact launcher (public site only; the portals reuse their top-bar assistant entry, never a
 * floating button) opens a panel: quick actions (ask about rooms, tour, apply), the thread, one field.
 *
 * A visitor's text is rendered as plain text. Only the assistant's and the team's replies are linkified, and only to links on
 * this site. New team replies arrive by a gentle poll (a coalesced single in-flight request, 8 s while the panel is open and
 * active, 30 s once idle, stopped after ten idle minutes or while the tab is hidden).
 */
import { MessageCircle, Phone, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CodeInput } from "@/components/public/phone-bound-link-ui";
import { useIsClient } from "@/hooks/use-is-client";
import { createCoalescedRefresher } from "@/lib/coalesced-refresh";
import "@/components/public-site/public-site.css";
import "@/components/marketing/web-chat.css";

const ENDPOINT = "/api/public/web-chat";
const ACTIVE_POLL_MS = 8_000;
const IDLE_POLL_MS = 30_000;
const ACTIVE_WINDOW_MS = 2 * 60_000;
const STOP_AFTER_MS = 10 * 60_000;

type Turn = { id: string; role: "visitor" | "assistant" | "team"; body: string; at: string };
type PollData = { turns?: Turn[]; verified?: boolean; signedIn?: boolean };

const newClientId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
const phoneLooksComplete = (value: string) => value.replace(/\D/g, "").length >= 10;

/** Plain text, with a link only where the text names this site (a relative path or this host). */
function renderBody(body: string, linkify: boolean): ReactNode {
  if (!linkify) return body;
  const parts = body.split(/(https?:\/\/[^\s]+)/g);
  return parts.map((part, index) => {
    if (!/^https?:\/\//.test(part)) return part;
    try {
      const url = new URL(part.replace(/[).,;!?]+$/, ""));
      if (url.host === window.location.host) {
        return (
          <a key={index} href={`${url.pathname}${url.search}`} className="ps-wc-link">
            {url.pathname}
          </a>
        );
      }
    } catch {
      /* not a URL */
    }
    return part;
  });
}

export function WebChatLauncher({ propertyId, roomId = null, label }: { propertyId: string; roomId?: string | null; label?: string }) {
  const isClient = useIsClient();
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState<{ id: string; body: string }[]>([]);
  const [draft, setDraft] = useState("");
  const [honeypot, setHoneypot] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const [verified, setVerified] = useState(false);
  const [phoneStep, setPhoneStep] = useState<"hidden" | "phone" | "code">("hidden");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const hasTurns = turns.length > 0;
  const lastActivity = useRef(0);
  const logRef = useRef<HTMLDivElement | null>(null);

  const refresher = useMemo(
    () =>
      createCoalescedRefresher<PollData | null>(async () => {
        try {
          const res = await fetch(`${ENDPOINT}?propertyId=${encodeURIComponent(propertyId)}`, { credentials: "same-origin", cache: "no-store" });
          return res.ok ? ((await res.json()) as PollData) : null;
        } catch {
          return null;
        }
      }),
    [propertyId],
  );

  const refresh = useCallback(
    async (force = false) => {
      const data = await refresher.run(force);
      if (!data) return;
      if (Array.isArray(data.turns)) {
        setTurns(data.turns);
        // A server copy of a message replaces its optimistic bubble.
        setPending((current) => current.filter((p) => !data.turns!.some((t) => t.role === "visitor" && t.body === p.body)));
      }
      if (typeof data.verified === "boolean") setVerified(data.verified);
    },
    [refresher],
  );

  // First open: one read to restore the conversation (and learn whether a signed-in account is looking).
  useEffect(() => {
    if (!open) return;
    lastActivity.current = Date.now();
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${ENDPOINT}?propertyId=${encodeURIComponent(propertyId)}&init=1`, { credentials: "same-origin", cache: "no-store" });
        const data = res.ok ? ((await res.json()) as PollData) : null;
        if (cancelled || !data) return;
        if (Array.isArray(data.turns)) setTurns(data.turns);
        if (typeof data.verified === "boolean") setVerified(data.verified);
        if (data.signedIn) setSignedIn(true);
      } catch {
        /* the panel still works for a new conversation */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, propertyId]);

  // The poll: only while open, only when the tab is visible, slower when idle, stopped after ten idle minutes.
  useEffect(() => {
    if (!open) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      const idleFor = Date.now() - lastActivity.current;
      if (idleFor > STOP_AFTER_MS) return;
      if (!document.hidden && hasTurns) void refresh(false);
      timer = setTimeout(tick, idleFor > ACTIVE_WINDOW_MS ? IDLE_POLL_MS : ACTIVE_POLL_MS);
    };
    timer = setTimeout(tick, ACTIVE_POLL_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [open, refresh, hasTurns]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    if (window.matchMedia("(max-width: 639px)").matches) document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [turns, pending, busy]);

  const send = useCallback(
    async (text: string) => {
      const body = text.trim();
      if (!body || busy) return;
      lastActivity.current = Date.now();
      setBusy(true);
      setError("");
      setPending((current) => [...current, { id: newClientId(), body }]);
      setDraft("");
      try {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ action: "send", propertyId, roomId, body, clientMessageId: newClientId(), website: honeypot }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string; phoneOffer?: string };
        if (!res.ok) {
          setPending((current) => current.filter((p) => p.body !== body));
          setDraft(body);
          setError(data.error ?? "We could not send that. Try again.");
          return;
        }
        if (data.phoneOffer && !verified) {
          setPhone(data.phoneOffer);
          setPhoneStep("phone");
        }
        await refresh(true);
      } catch {
        setPending((current) => current.filter((p) => p.body !== body));
        setDraft(body);
        setError("Could not reach PropLane. Check your connection.");
      } finally {
        setBusy(false);
      }
    },
    [busy, honeypot, propertyId, refresh, roomId, verified],
  );

  const call = useCallback(async (body: Record<string, unknown>) => {
    try {
      const res = await fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ propertyId, ...body }) });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: res.ok, error: data.error };
    } catch {
      return { ok: false, error: "Could not reach PropLane. Check your connection." };
    }
  }, [propertyId]);

  const requestCode = async () => {
    if (busy || !phoneLooksComplete(phone)) return;
    setBusy(true);
    setError("");
    const result = await call({ action: "phone_code", phone });
    setBusy(false);
    if (!result.ok) return setError(result.error ?? "We could not text that number. Check it and try again.");
    setOtp("");
    setPhoneStep("code");
  };

  const verify = async () => {
    if (busy || otp.length !== 6) return;
    setBusy(true);
    setError("");
    const result = await call({ action: "phone_verify", phone, otp });
    setBusy(false);
    if (!result.ok) return setError(result.error ?? "That code did not work.");
    setVerified(true);
    setPhoneStep("hidden");
    await refresh(true);
  };

  const empty = turns.length === 0 && pending.length === 0;
  const tourHref = `/rent/tours-contact?propertyId=${encodeURIComponent(propertyId)}`;
  const applyHref = `/rent/apply?propertyId=${encodeURIComponent(propertyId)}`;

  return (
    <>
      {!open ? (
        <button type="button" className="ps ps-wc-launch" onClick={() => setOpen(true)} aria-label="Chat with PropLane" data-attr="web-chat-open">
          <MessageCircle className="h-[20px] w-[20px]" strokeWidth={1.75} aria-hidden />
          <span>Chat</span>
        </button>
      ) : null}
      {open && isClient
        ? createPortal(
            <div className="ps ps-wc-panel" role="dialog" aria-label="Chat with PropLane" data-attr="web-chat-panel">
              <div className="ps-wc-head">
                <h2 className="ps-h3">{label ? `Chat · ${label}` : "Chat"}</h2>
                <button type="button" className="ps-icon-btn" onClick={() => setOpen(false)} aria-label="Close" title="Close" data-attr="web-chat-close">
                  <X className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
                </button>
              </div>
              <div className="ps-wc-log" ref={logRef} aria-live="polite">
                {empty ? (
                  <div className="ps-wc-quick">
                    <button type="button" className="ps-btn ps-btn-line" onClick={() => void send("What rooms are available and what do they cost?")} data-attr="web-chat-ask-rooms">
                      Ask about rooms
                    </button>
                    <a className="ps-btn ps-btn-line" href={tourHref} data-attr="web-chat-tour">
                      Book a tour
                    </a>
                    <a className="ps-btn ps-btn-line" href={applyHref} data-attr="web-chat-apply">
                      Apply
                    </a>
                    {signedIn ? (
                      <a className="ps-btn ps-btn-blue" href="/auth/continue" data-attr="web-chat-open-assistant">
                        Open your assistant
                      </a>
                    ) : null}
                  </div>
                ) : null}
                {turns.map((turn) => (
                  <p key={turn.id} className={`ps-wc-turn ps-wc-${turn.role}`}>
                    {renderBody(turn.body, turn.role !== "visitor")}
                  </p>
                ))}
                {pending.map((p) => (
                  <p key={p.id} className="ps-wc-turn ps-wc-visitor ps-wc-pending">
                    {p.body}
                  </p>
                ))}
                {busy ? <p className="ps-wc-turn ps-wc-assistant ps-wc-typing" aria-label="Typing">…</p> : null}
              </div>
              {phoneStep !== "hidden" ? (
                <div className="ps-wc-phone">
                  {phoneStep === "phone" ? (
                    <>
                      <label className="ps-field">
                        <span>Phone</span>
                        <input className="ps-input" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} data-attr="web-chat-phone" />
                      </label>
                      <button type="button" className="ps-btn ps-btn-blue" disabled={busy || !phoneLooksComplete(phone)} onClick={() => void requestCode()} data-attr="web-chat-phone-send">
                        Text me a code
                      </button>
                    </>
                  ) : (
                    <>
                      <CodeInput value={otp} onChange={setOtp} onEnter={() => void verify()} dataAttr="web-chat-code" />
                      <button type="button" className="ps-btn ps-btn-blue" disabled={busy || otp.length !== 6} onClick={() => void verify()} data-attr="web-chat-verify">
                        Verify
                      </button>
                    </>
                  )}
                  <button type="button" className="ps-text-btn" onClick={() => setPhoneStep("hidden")} data-attr="web-chat-phone-skip">
                    Not now
                  </button>
                </div>
              ) : !verified && turns.length > 0 ? (
                <button type="button" className="ps-text-btn ps-wc-continue" onClick={() => setPhoneStep("phone")} data-attr="web-chat-continue-by-text">
                  <Phone className="h-[14px] w-[14px]" strokeWidth={1.75} aria-hidden /> Continue by text
                </button>
              ) : null}
              {error ? (
                <p className="ps-error" role="alert" data-attr="web-chat-error">
                  {error}
                </p>
              ) : null}
              <form
                className="ps-wc-compose"
                onSubmit={(event) => {
                  event.preventDefault();
                  void send(draft);
                }}
              >
                {/* The honeypot: a field no person sees or fills. */}
                <input className="ps-wc-hp" tabIndex={-1} autoComplete="off" aria-hidden name="website" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
                <textarea
                  className="ps-input"
                  rows={1}
                  maxLength={1000}
                  value={draft}
                  autoFocus
                  aria-label="Message"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send(draft);
                    }
                  }}
                  data-attr="web-chat-input"
                />
                <button type="submit" className="ps-btn ps-btn-blue" disabled={busy || !draft.trim()} data-attr="web-chat-send">
                  Send
                </button>
              </form>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
