"use client";

/**
 * Message a home, or one room of it, with no account (design-1112 §1).
 *
 * Three steps in the public site's own look: write the message and give a phone number (a first name is optional);
 * type the six-digit code texted to that number; then a sent state with the two next doors, "Create account" (the
 * personal link, which opens account creation with the phone already linked) and "Text us". No email, no password,
 * no explanation under a field. A signed-in visitor whose verified phone is the one typed skips the code (the server
 * decides; `skipCode`). Browsing stays fully signed-out and the pages stay cacheable: this is a client island that
 * only talks to the rate-limited `POST /api/public/listing-message` when the visitor presses a button.
 */
import { X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePublicTexting } from "@/components/marketing/public-texting-context";
import { CodeInput } from "@/components/public/phone-bound-link-ui";
import { useIsClient } from "@/hooks/use-is-client";
import { textUsBody, textUsHref } from "@/lib/personal-link/text-us";
import "@/components/public-site/public-site.css";

const ENDPOINT = "/api/public/listing-message";

type Step = "compose" | "code" | "sent";
type Reply = { ok: boolean; status: number; data: { ok?: boolean; error?: string; skipCode?: boolean; accountUrl?: string; needsNewCode?: boolean; textCode?: string | null } };

async function call(body: Record<string, unknown>): Promise<Reply> {
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Reply["data"];
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: "Could not reach PropLane. Check your connection." } };
  }
}

/** Digits of a typed phone, for the enabled check only; the server re-validates. */
const phoneLooksComplete = (value: string) => value.replace(/\D/g, "").length >= 10;

// ---------------------------------------------------------------------------------------------
// Text us
// ---------------------------------------------------------------------------------------------

const codeCache = new Map<string, Promise<string | null>>();

/** The home's entry code for the Text us body. One request per home per page load; a failure just means no code. */
export function useListingTextUsCode(propertyId: string, enabled: boolean): string | null {
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled || !propertyId) return;
    let cancelled = false;
    let pending = codeCache.get(propertyId);
    if (!pending) {
      pending = fetch(`${ENDPOINT}?propertyId=${encodeURIComponent(propertyId)}`, { credentials: "omit" })
        .then((res) => (res.ok ? res.json() : { textCode: null }))
        .then((data: { textCode?: unknown }) => (typeof data.textCode === "string" ? data.textCode : null))
        .catch(() => {
          codeCache.delete(propertyId);
          return null;
        });
      codeCache.set(propertyId, pending);
    }
    void pending.then((value) => {
      if (!cancelled) setCode(value);
    });
    return () => {
      cancelled = true;
    };
  }, [propertyId, enabled]);
  return code;
}

/**
 * "Text us": an `sms:` link to the ONE configured PropLane line, prefilled with the home (and room) and its entry code.
 * Nothing is drawn when no number is configured. This is the only place a /rent page carries a number or an sms: link.
 */
export function ListingTextUsLink({
  propertyId,
  label,
  roomLabel,
  className,
  dataAttr = "listing-text-us",
  children = "Text us",
}: {
  propertyId: string;
  label: string;
  roomLabel?: string | null;
  className?: string;
  dataAttr?: string;
  children?: ReactNode;
}) {
  const { phone } = usePublicTexting();
  const code = useListingTextUsCode(propertyId, Boolean(phone));
  const href = useMemo(() => (phone ? textUsHref(phone, textUsBody({ label, roomLabel, code })) : ""), [phone, label, roomLabel, code]);
  if (!href) return null;
  return (
    <a href={href} className={className} data-attr={dataAttr}>
      {children}
    </a>
  );
}

// ---------------------------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------------------------

export type ListingMessageTarget = {
  propertyId: string;
  /** What the home is called on this page; used only to word the Text us body. */
  propertyLabel: string;
  roomId?: string | null;
  roomLabel?: string | null;
};

/** The three steps, inline. The sheet wraps it; the tours-contact Message tab draws it directly. */
export function ListingMessageForm({ target, onClose }: { target: ListingMessageTarget; onClose?: () => void }) {
  const [step, setStep] = useState<Step>("compose");
  const [body, setBody] = useState("");
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [accountUrl, setAccountUrl] = useState<string | null>(null);
  const firstField = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    firstField.current?.focus();
  }, []);

  const base = useMemo(
    () => ({ propertyId: target.propertyId, roomId: target.roomId ?? undefined, phone, body: body.trim() }),
    [target.propertyId, target.roomId, phone, body],
  );

  const send = useCallback(
    async (otpValue?: string) => {
      const result = await call({ action: "verify_send", ...base, name: name.trim() || undefined, otp: otpValue ?? "" });
      if (result.ok) {
        setAccountUrl(typeof result.data.accountUrl === "string" ? result.data.accountUrl : null);
        setStep("sent");
        return;
      }
      if (result.data.needsNewCode) setOtp("");
      setError(result.data.error ?? "We could not send that. Try again.");
    },
    [base, name],
  );

  const requestCode = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await call({ action: "send_code", ...base });
      if (!result.ok) {
        setError(result.data.error ?? "We could not text that number. Check it and try again.");
        return;
      }
      if (result.data.skipCode) {
        await send();
        return;
      }
      setOtp("");
      setStep("code");
    } finally {
      setBusy(false);
    }
  }, [base, busy, send]);

  const verify = useCallback(async () => {
    if (busy || otp.length !== 6) return;
    setBusy(true);
    setError("");
    try {
      await send(otp);
    } finally {
      setBusy(false);
    }
  }, [busy, otp, send]);

  const subject = [target.propertyLabel, target.roomLabel].filter(Boolean).join(" · ");

  if (step === "sent") {
    return (
      <div className="ps-msg-sent" data-attr="listing-message-sent" role="status">
        <h2 className="ps-h2">Message sent</h2>
        <div className="ps-msg-pair">
          {accountUrl ? (
            <a href={accountUrl} className="ps-btn ps-btn-blue" data-attr="listing-message-create-account">
              Create account
            </a>
          ) : null}
          <ListingTextUsLink
            propertyId={target.propertyId}
            label={target.propertyLabel}
            roomLabel={target.roomLabel}
            className="ps-btn ps-btn-line"
            dataAttr="listing-message-text-us"
          />
        </div>
        {onClose ? (
          <button type="button" className="ps-text-btn" onClick={onClose} data-attr="listing-message-done">
            Done
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="ps-msg-form" data-attr="listing-message-form">
      {subject ? <h2 className="ps-h3" data-attr="listing-message-title">{subject}</h2> : null}
      {step === "compose" ? (
        <>
          <label className="ps-field">
            <span>Message</span>
            <textarea
              ref={firstField}
              className="ps-input"
              rows={4}
              maxLength={1000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              data-attr="listing-message-body"
            />
          </label>
          <label className="ps-field">
            <span>Phone</span>
            <input
              className="ps-input"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              data-attr="listing-message-phone"
            />
          </label>
          <label className="ps-field">
            <span>First name</span>
            <input
              className="ps-input"
              autoComplete="given-name"
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-attr="listing-message-name"
            />
          </label>
          <button
            type="button"
            className="ps-btn ps-btn-blue"
            disabled={busy || body.trim().length === 0 || !phoneLooksComplete(phone)}
            onClick={() => void requestCode()}
            data-attr="listing-message-send"
          >
            {busy ? "Sending…" : "Send message"}
          </button>
        </>
      ) : (
        <>
          <CodeInput value={otp} onChange={setOtp} onEnter={() => void verify()} dataAttr="listing-message-code" />
          <button type="button" className="ps-btn ps-btn-blue" disabled={busy || otp.length !== 6} onClick={() => void verify()} data-attr="listing-message-verify">
            {busy ? "Sending…" : "Verify and send"}
          </button>
          <button type="button" className="ps-text-btn" disabled={busy} onClick={() => void requestCode()} data-attr="listing-message-resend">
            Send a new code
          </button>
          <button type="button" className="ps-text-btn" disabled={busy} onClick={() => { setStep("compose"); setError(""); }} data-attr="listing-message-back">
            Back
          </button>
        </>
      )}
      {error ? (
        <p className="ps-error" role="alert" data-attr="listing-message-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The sheet and its trigger
// ---------------------------------------------------------------------------------------------

export function ListingMessageSheet({ open, onClose, target }: { open: boolean; onClose: () => void; target: ListingMessageTarget }) {
  const isClient = useIsClient();
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  if (!open || !isClient) return null;
  return createPortal(
    <div className="ps ps-msg-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} data-attr="listing-message-sheet">
      <div className="ps-msg-panel" role="dialog" aria-modal="true" aria-label="Message">
        <button type="button" className="ps-icon-btn ps-msg-close" onClick={onClose} aria-label="Close" title="Close" data-attr="listing-message-close">
          <X className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
        </button>
        <ListingMessageForm target={target} onClose={onClose} />
      </div>
    </div>,
    document.body,
  );
}

/** The Message action: a button that opens the sheet for this home (and room). */
export function ListingMessageButton({
  target,
  className,
  dataAttr = "listing-message",
  children = "Message",
}: {
  target: ListingMessageTarget;
  className?: string;
  dataAttr?: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} data-attr={dataAttr} aria-haspopup="dialog">
        {children}
      </button>
      <ListingMessageSheet open={open} onClose={close} target={target} />
    </>
  );
}
