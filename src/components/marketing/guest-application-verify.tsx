"use client";

/**
 * "Verify to submit": the last step of an application made with no account (captain, Nov 14: a renter from Facebook,
 * Zillow or Roomies applies without creating an account first).
 *
 * The finished application is held server-side (`POST /api/public/application-drafts`, 24 hours, unguessable token),
 * then the renter proves ONE thing:
 *   - a phone: a code texted by the existing phone sign-in door, which creates the phone-only resident account only after
 *     the code is right, or
 *   - a phone, by a texted single-use link (`POST /api/public/guest-signup-link`): opening it on that phone is the proof, or
 *   - a mailbox: the existing emailed `token_hash` link (`/auth/confirm`), whose destination the server decides.
 * Either way they land in the resident portal's apply page, which claims the held draft (the session is the proof) and
 * submits it through the ordinary signed-in write. Nothing here creates an account or an application row.
 */
import { useState } from "react";
import { CodeInput } from "@/components/public/phone-bound-link-ui";
import { normalizeE164 } from "@/lib/phone-e164";
import { residentPortalApplyReturnPath } from "@/lib/rental-application/public-apply-session";
import type { RentalWizardFormState } from "@/lib/rental-application/types";

const TOKEN_KEY = "axis:guest-application-draft-token:v1";
const CLAIM_ATTEMPT_KEY = "axis:guest-application-claim-attempt:v1";

type Method = "sms" | "email";
type Stage = "choose" | "code" | "email-sent" | "link-sent";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function sessionStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function rememberToken(propertyId: string, token: string) {
  try {
    storage()?.setItem(TOKEN_KEY, JSON.stringify({ propertyId, token }));
    sessionStore()?.removeItem(`${CLAIM_ATTEMPT_KEY}:${propertyId}`);
  } catch {
    /* the claim also works from the verified phone or email alone */
  }
}

function recalledToken(propertyId: string): string | null {
  try {
    const parsed = JSON.parse(storage()?.getItem(TOKEN_KEY) ?? "null") as { propertyId?: unknown; token?: unknown } | null;
    return parsed && parsed.propertyId === propertyId && typeof parsed.token === "string" ? parsed.token : null;
  } catch {
    return null;
  }
}

/** True the first time this tab asks about this home since a draft was held; the portal wizard claims once, not on every render. */
export function rememberGuestDraftClaimAttempt(propertyId: string): boolean {
  const store = sessionStore();
  if (!store) return true;
  const key = `${CLAIM_ATTEMPT_KEY}:${propertyId}`;
  if (store.getItem(key)) return false;
  try {
    store.setItem(key, "1");
  } catch {
    /* ignore */
  }
  return true;
}

/** The held guest application for this home, or null. The server decides from the session; the token only narrows the lookup. */
export async function claimGuestApplicationDraftClient(propertyId: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch("/api/resident/application-drafts/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ propertyId, token: recalledToken(propertyId) ?? undefined }),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { ok?: boolean; form?: Record<string, unknown> } | null;
    if (body?.ok && body.form && typeof body.form === "object") {
      try {
        storage()?.removeItem(TOKEN_KEY);
      } catch {
        /* ignore */
      }
      return body.form;
    }
  } catch {
    /* a failed claim leaves the local draft in place */
  }
  return null;
}

async function post(path: string, body: Record<string, unknown>) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok && !data.error, status: res.status, data };
}

export function GuestApplicationVerify({ form, onBack }: { form: RentalWizardFormState; onBack: () => void }) {
  const propertyId = form.propertyId.trim();
  const phoneE164 = normalizeE164(form.phone ?? "");
  const email = form.email.trim().toLowerCase();
  const [stage, setStage] = useState<Stage>("choose");
  const [challengeId, setChallengeId] = useState("");
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nextPath = residentPortalApplyReturnPath({
    propertyId,
    rentalType: form.rentalType === "short_term" ? "short_term" : undefined,
  });

  /** Hold the draft first; it is what the verified resident claims. */
  async function hold(): Promise<string | null> {
    const held = await post("/api/public/application-drafts", { propertyId, form });
    if (!held.ok || typeof held.data.token !== "string") {
      setError(typeof held.data.error === "string" ? held.data.error : "We could not save your application. Please try again.");
      return null;
    }
    rememberToken(propertyId, held.data.token);
    return held.data.token;
  }

  async function sendCode() {
    if (!phoneE164) return;
    setBusy(true);
    setError("");
    try {
      if (!(await hold())) return;
      const started = await post("/api/auth/phone/start", { phone: phoneE164, purpose: "sign_in" });
      if (!started.ok || typeof started.data.challengeId !== "string") {
        setError("We could not text that number. Check it and try again, or use email.");
        return;
      }
      setChallengeId(started.data.challengeId);
      setOtp("");
      setStage("code");
    } finally {
      setBusy(false);
    }
  }

  /** A texted single-use link: opening it on this phone is the proof, and it creates (or signs into) the account. */
  async function sendLink() {
    if (!phoneE164) return;
    setBusy(true);
    setError("");
    try {
      const draftToken = await hold();
      if (!draftToken) return;
      const sent = await post("/api/public/guest-signup-link", { kind: "apply", draftToken });
      if (!sent.ok) {
        setError(typeof sent.data.error === "string" ? sent.data.error : "We could not text that number. Use a code or email instead.");
        return;
      }
      setStage("link-sent");
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode() {
    if (otp.length !== 6 || !challengeId) return;
    setBusy(true);
    setError("");
    try {
      const verified = await post("/api/auth/phone/verify", { challengeId, code: otp, purpose: "sign_in", intent: "resident_signup", next: nextPath });
      if (!verified.ok) {
        setError("That code did not work. Ask for a new code.");
        return;
      }
      window.location.assign(typeof verified.data.next === "string" && verified.data.next.startsWith("/") ? verified.data.next : nextPath);
    } finally {
      setBusy(false);
    }
  }

  async function sendEmail() {
    setBusy(true);
    setError("");
    try {
      if (!(await hold())) return;
      const started = await post("/api/auth/email-onboarding/start", {
        email,
        intent: "resident",
        propertyId,
        ...(form.rentalType === "short_term" || form.rentalType === "standard" ? { rentalType: form.rentalType } : {}),
      });
      if (!started.ok) {
        setError(typeof started.data.error === "string" ? started.data.error : "We could not send that email. Please try again.");
        return;
      }
      setStage("email-sent");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ps-j-stack" style={{ gap: 18 }} data-attr="guest-application-verify">
      <h2 className="ps-h3">Verify to submit</h2>
      {stage === "choose" ? (
        <>
          {phoneE164 ? (
            <button type="button" className="ps-btn ps-btn-blue ps-btn-block" disabled={busy} onClick={() => void sendCode()} data-attr="guest-apply-text-code">
              {busy ? "Sending…" : "Text me a code"}
            </button>
          ) : null}
          {phoneE164 ? (
            <button type="button" className="ps-btn ps-btn-line ps-btn-block" disabled={busy} onClick={() => void sendLink()} data-attr="guest-apply-text-link">
              {busy ? "Sending…" : "Text me a link"}
            </button>
          ) : null}
          <button type="button" className={phoneE164 ? "ps-btn ps-btn-line ps-btn-block" : "ps-btn ps-btn-blue ps-btn-block"} disabled={busy} onClick={() => void sendEmail()} data-attr="guest-apply-email-link">
            {busy ? "Sending…" : "Email me a link"}
          </button>
          <button type="button" className="ps-text-btn" disabled={busy} onClick={onBack} data-attr="guest-apply-back">
            Back
          </button>
        </>
      ) : null}
      {stage === "code" ? (
        <>
          <CodeInput value={otp} onChange={setOtp} onEnter={() => void verifyCode()} dataAttr="guest-apply-code" />
          <button type="button" className="ps-btn ps-btn-blue ps-btn-block" disabled={busy || otp.length !== 6} onClick={() => void verifyCode()} data-attr="guest-apply-verify">
            {busy ? "Verifying…" : "Verify and submit"}
          </button>
          <button type="button" className="ps-text-btn" disabled={busy} onClick={() => void sendCode()} data-attr="guest-apply-resend">
            Send a new code
          </button>
        </>
      ) : null}
      {stage === "email-sent" ? (
        <p role="status" data-attr="guest-apply-email-sent">Check {email} for your link.</p>
      ) : null}
      {stage === "link-sent" ? (
        <p role="status" data-attr="guest-apply-link-sent">Check your phone for your link.</p>
      ) : null}
      {error ? (
        <p className="ps-error" role="alert" data-attr="guest-apply-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
