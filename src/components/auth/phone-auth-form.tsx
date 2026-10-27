"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { PhoneCodeInput } from "@/components/auth/phone-code-input";
import { useAuthWelcomeChrome } from "@/components/auth/use-auth-welcome-chrome";
import { Input } from "@/components/ui/input";
import { nativeAwarePath } from "@/lib/auth/native-auth-entry";
import { isUnsafeRedirectPath } from "@/lib/auth/normalize-post-auth-path";
import { oauthContinuePath } from "@/lib/auth/oauth-redirect";
import { PHONE_AUTH_COPY, PHONE_CODE_EXPIRED_RESENT_COPY, isPhoneAuthErrorKind, type PhoneAuthErrorKind } from "@/lib/auth/phone-auth-errors";
import { formatCountdown } from "@/lib/auth/phone-code-input";
import { readRememberedLoginPhone, rememberLoginMethod, rememberLoginPhone } from "@/lib/auth/remembered-login";
import { formatPhoneInput, phoneDisplayLabel, phoneSubmitValue } from "@/lib/phone-format";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

type Purpose = "sign_in" | "verify_phone" | "change_number_old" | "change_number_new";
type PhoneStatus = { enabled: boolean; verified: boolean; phone: string | null; needsOldNumber: boolean };
type PhoneResponse = {
  error?: string;
  /** Sign-in door only: which plain sentence `error` carries (see phone-auth-errors.ts). */
  kind?: PhoneAuthErrorKind;
  /** The switch is off: the form hides itself (the server's answer wins over the page's earlier read). */
  phoneOff?: boolean;
  /** An expired code: whether a fresh one would still be sent inside the hourly cap. */
  canResend?: boolean;
  /** The code could not be sent (a provider problem), so the screen may offer "Skip for now". */
  sendFailed?: boolean;
  challengeId?: string;
  ok?: boolean;
  next?: string;
  oldNumberVerified?: boolean;
  session?: { access_token: string; refresh_token: string };
};

const REQUEST_ERROR = "Could not verify your phone. Please try again.";
/** The resend button unlocks this long after a code is sent, so it never burns the 3-an-hour cap by reflex. */
const RESEND_COOLDOWN_MS = 30_000;

class PhoneRequestError extends Error {
  constructor(message: string, readonly response: PhoneResponse) {
    super(message);
  }
}

/** A server-resolved destination, only if it is a same-origin path that is not the continue page itself. */
function resolvedNext(next: unknown): string | null {
  if (typeof next !== "string" || !next.startsWith("/") || isUnsafeRedirectPath(next)) return null;
  const path = next.split(/[?#]/)[0];
  return path === "/auth/continue" ? null : next;
}

type SubmitOptions = { resend?: boolean; code?: string; autoResend?: boolean };

export function PhoneAuthForm({
  mode = "sign_in",
  nextPath = "",
  disabled = false,
  allowSkip = false,
  onBusyChange,
  onPhoneOff,
}: {
  mode?: "sign_in" | "verify_phone";
  nextPath?: string;
  disabled?: boolean;
  /** phone_required (not the shared line): when a code cannot be sent, offer "Skip for now" so an outage never locks anyone out. */
  allowSkip?: boolean;
  onBusyChange?: (busy: boolean) => void;
  /** The server says phone sign-in is off (409). The parent hides this form and shows the off sentence. */
  onPhoneOff?: () => void;
}) {
  // /auth/verify-phone has no other client component to mark the document, so without this the auth shell
  // draws the full public footer (wave art + giant mark) over the form on desktop. Sign-in already marks it.
  useAuthWelcomeChrome(mode === "verify_phone");
  const [purpose, setPurpose] = useState<Purpose>(mode);
  const [phone, setPhone] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(mode !== "sign_in");
  const [statusFailed, setStatusFailed] = useState(false);
  const [statusVersion, setStatusVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [canSkip, setCanSkip] = useState(false);
  // Sign-in only: the six-box code step, the +1 field, the resend countdown. The Settings/verify flows keep their plain fields.
  const signInUi = mode === "sign_in";
  const [code, setCode] = useState("");
  const [codeInvalid, setCodeInvalid] = useState(false);
  const [needsNewCode, setNeedsNewCode] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [resendUnlockAt, setResendUnlockAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const inFlight = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const submitRef = useRef<(options?: SubmitOptions) => Promise<void>>(async () => undefined);

  // The last number used on this device, like the remembered email.
  useEffect(() => {
    if (mode !== "sign_in") return;
    const remembered = readRememberedLoginPhone();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration from stored login on mount
    if (remembered) setPhone((current) => current || formatPhoneInput(remembered));
  }, [mode]);

  // Resend countdown: ticks once a second while a code is waiting.
  useEffect(() => {
    if (!challengeId || !signInUi) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [challengeId, signInUi]);

  // Web OTP: Android Chrome hands the code from the text to the page; one verify per challenge (inFlight guards the rest).
  useEffect(() => {
    if (!challengeId || !signInUi) return;
    if (typeof window === "undefined" || !("OTPCredential" in window) || !navigator.credentials?.get) return;
    const abort = new AbortController();
    try {
      void navigator.credentials
        .get({ otp: { transport: ["sms"] }, signal: abort.signal } as CredentialRequestOptions)
        .then((credential) => {
          const delivered = (credential as { code?: string } | null)?.code;
          if (abort.signal.aborted || !delivered || !/^\d{6}$/.test(delivered)) return;
          setCode(delivered);
          void submitRef.current({ code: delivered });
        })
        .catch(() => undefined);
    } catch {
      /* Web OTP is a convenience; typing the code still works. */
    }
    return () => abort.abort();
  }, [challengeId, signInUi]);

  useEffect(() => {
    if (mode === "sign_in") return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/auth/phone", { cache: "no-store", signal: controller.signal });
        const status = await response.json() as PhoneStatus;
        if (!response.ok || !status.enabled) throw new Error(REQUEST_ERROR);
        if (controller.signal.aborted) return;
        if (status.needsOldNumber) {
          if (!status.phone) throw new Error(REQUEST_ERROR);
          setPurpose("change_number_old");
          setPhone(status.phone);
        } else if (status.phone && !status.verified) {
          // The number typed at signup is already on the profile, unverified until the code is entered: prefill it.
          setPhone((current) => current || status.phone!);
        }
        setStatusFailed(false);
      } catch {
        if (controller.signal.aborted) return;
        setStatusFailed(true);
        setError(REQUEST_ERROR);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [mode, statusVersion]);

  const request = async (path: "/api/auth/phone/start" | "/api/auth/phone/verify", body: Record<string, string>): Promise<PhoneResponse> => {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json() as PhoneResponse;
    if (!response.ok || result.error) {
      if (allowSkip && path === "/api/auth/phone/start" && result.sendFailed) setCanSkip(true);
      throw new PhoneRequestError(result.error || REQUEST_ERROR, result);
    }
    return result;
  };

  const startCode = async (submittedPhone: string) => {
    const result = await request("/api/auth/phone/start", { phone: submittedPhone, purpose });
    if (!result.challengeId) throw new Error(REQUEST_ERROR);
    setPhone(signInUi ? phoneDisplayLabel(submittedPhone) : submittedPhone);
    setChallengeId(result.challengeId);
    setCode("");
    setCodeInvalid(false);
    setNeedsNewCode(false);
    setNow(Date.now());
    setResendUnlockAt(Date.now() + RESEND_COOLDOWN_MS);
    const codeField = formRef.current?.elements.namedItem("code") as HTMLInputElement | null;
    if (codeField) codeField.value = "";
  };

  const submit = async (options: SubmitOptions = {}) => {
    const resend = options.resend === true;
    if (disabled || loading || statusFailed || inFlight.current) return;
    const fields = new FormData(formRef.current!);
    // WebKit AutoFill may update the DOM without firing React's onChange.
    const typedPhone = purpose === "change_number_old" ? phone : String(fields.get("phone") ?? "").trim();
    const submittedPhone = signInUi ? phoneSubmitValue(typedPhone) : typedPhone;
    // The DOM is read as a fallback for the same reason as the phone: WebKit AutoFill can fill the box without a change event.
    const submittedCode = signInUi ? (options.code ?? (code || String(fields.get("code") ?? "").trim())) : String(fields.get("code") ?? "").trim();
    if ((!challengeId || resend) && !submittedPhone) {
      setError(signInUi ? PHONE_AUTH_COPY.bad_number : "Enter your phone number.");
      return;
    }
    if (challengeId && !resend && !/^\d{6}$/.test(submittedCode)) {
      setError("Enter the 6-digit code.");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    setNotice(null);
    let sendFreshCode = false;
    try {
      if (!challengeId || resend) {
        await startCode(submittedPhone);
        if (options.autoResend) setNotice(PHONE_CODE_EXPIRED_RESENT_COPY);
      } else {
        const result = await request("/api/auth/phone/verify", signInUi
          // `purpose` only picks the wording of a failure; `next` is the deep link, re-validated on the server.
          ? { challengeId, code: submittedCode, purpose: "sign_in", ...(nextPath ? { next: nextPath } : {}) }
          : { challengeId, code: submittedCode });
        if (!result.ok) throw new Error(REQUEST_ERROR);
        if (purpose === "change_number_old") {
          if (!result.oldNumberVerified) throw new Error(REQUEST_ERROR);
          setPurpose("change_number_new");
          setChallengeId(null);
          setPhone("");
          return;
        }
        if (result.session) {
          const { error: sessionError } = await createSupabaseBrowserClient().auth.setSession(result.session);
          if (sessionError) throw new Error(REQUEST_ERROR);
        }
        if (signInUi) {
          rememberLoginPhone(phoneDisplayLabel(phone));
          rememberLoginMethod("phone");
          // The server already ran the post-sign-in resolver for this session (a ?next= deep link wins inside it);
          // /auth/continue stays the fallback when it could not.
          const direct = resolvedNext(result.next);
          window.location.replace(direct ? nativeAwarePath(direct) : oauthContinuePath(nextPath));
        } else {
          window.location.replace(oauthContinuePath(nextPath || result.next || ""));
        }
      }
    } catch (cause) {
      const failure = cause instanceof PhoneRequestError ? cause.response : null;
      const kind = failure?.kind && isPhoneAuthErrorKind(failure.kind) ? failure.kind : null;
      if (failure?.phoneOff || kind === "off") {
        setError(PHONE_AUTH_COPY.off);
        onPhoneOff?.();
        return;
      }
      if (signInUi && challengeId && !resend) {
        // A wrong or expired code leaves the boxes empty and focused for the next try.
        setCode("");
        setCodeInvalid(kind === "wrong_code");
      }
      if (signInUi && kind === "expired" && challengeId && !resend) {
        setError(PHONE_AUTH_COPY.expired);
        setNeedsNewCode(true);
        // Auto-send a fresh code only when the server says the hourly cap still allows one.
        sendFreshCode = failure?.canResend === true && Boolean(phone);
      } else {
        setError(cause instanceof Error ? cause.message : REQUEST_ERROR);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
    // After the guard is released, so the resend is an ordinary submit (the server still enforces the cap).
    if (sendFreshCode) await submit({ resend: true, autoResend: true });
  };
  useEffect(() => {
    submitRef.current = submit;
  });

  const skip = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const response = await fetch("/api/auth/phone/skip", { method: "POST" });
      if (!response.ok) throw new Error(REQUEST_ERROR);
      window.location.replace(oauthContinuePath(nextPath));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : REQUEST_ERROR);
      inFlight.current = false;
      setBusy(false);
    }
  };

  const locked = disabled || busy || loading || statusFailed;
  const phoneLabel = purpose === "change_number_old" ? "Current phone number" : purpose === "change_number_new" ? "New phone number" : "Phone number";
  const secondsLeft = Math.max(0, Math.ceil((resendUnlockAt - now) / 1000));
  const resendLocked = signInUi && !needsNewCode && secondsLeft > 0;
  const changeNumber = useCallback(() => {
    setChallengeId(null);
    setCode("");
    setCodeInvalid(false);
    setNeedsNewCode(false);
    setNotice(null);
    setError(null);
  }, []);

  // The boxes hand focus back after every attempt, so a wrong code is retyped without touching the screen.
  useEffect(() => {
    if (signInUi && challengeId && !busy) codeRef.current?.focus();
  }, [signInUi, challengeId, busy]);

  const onCodeChange = (digits: string) => {
    setCode(digits);
    setCodeInvalid(false);
    setError(null);
    setNotice(null);
    // The 6th digit signs in: no button. `inFlight` makes autofill + Web OTP + typing land as ONE verify.
    if (digits.length === 6) void submit({ code: digits });
  };

  return (
    <form ref={formRef} className="space-y-3" aria-label="Phone verification" onSubmit={(event) => {
      event.preventDefault();
      void submit();
    }}>
      {signInUi && challengeId ? (
        <>
          <input type="hidden" name="phone" value={phone} readOnly />
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="auth-phone-code" className="block text-sm font-medium text-foreground">Code sent to {phoneDisplayLabel(phone)}</label>
            <Button type="button" variant="ghost" disabled={locked} onClick={changeNumber} data-attr="auth-phone-change-number">Change</Button>
          </div>
        </>
      ) : (
        <>
          <label htmlFor="auth-phone-number" className="block text-sm font-medium text-foreground">{phoneLabel}</label>
          <div className="relative">
            {signInUi ? (
              <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-4 flex items-center text-[16px] font-medium text-foreground sm:text-sm">+1</span>
            ) : null}
            <Input id="auth-phone-number" name="phone" type="tel" autoComplete="tel" inputMode="tel"
              className={signInUi ? "pl-11" : ""}
              placeholder={signInUi ? "(555) 555-0123" : "+1 (555) 555-0123"} value={phone}
              onChange={(event) => { setPhone(signInUi ? formatPhoneInput(event.target.value) : event.target.value); setError(null); }}
              readOnly={Boolean(challengeId) || purpose === "change_number_old"} disabled={locked}
              aria-describedby={error ? "auth-phone-error" : undefined} />
          </div>
        </>
      )}
      {challengeId && signInUi ? (
        <PhoneCodeInput ref={codeRef} id="auth-phone-code" value={code} onChange={onCodeChange} disabled={locked}
          invalid={codeInvalid} describedBy={error ? "auth-phone-error" : undefined} />
      ) : challengeId ? (
        <div className="space-y-2">
          <label htmlFor="auth-phone-code" className="block text-sm font-medium text-foreground">Verification code</label>
          <Input key={challengeId} id="auth-phone-code" name="code" type="text" inputMode="numeric"
            autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} placeholder="6-digit code"
            autoFocus disabled={locked} aria-describedby={error ? "auth-phone-error" : undefined} />
        </div>
      ) : null}
      {error ? <p id="auth-phone-error" role="alert" className="text-sm text-danger">{error}</p> : null}
      {notice && !error ? <p role="status" className="text-sm text-muted">{notice}</p> : null}
      {statusFailed ? (
        <Button type="button" variant="secondary" className="w-full" onClick={() => {
          setLoading(true); setStatusFailed(false); setError(null); setStatusVersion((value) => value + 1);
        }}>Try again</Button>
      ) : signInUi && challengeId ? null : (
        <Button type="submit" className="btn-cobalt w-full rounded-full py-2.5 text-[15px] font-semibold"
          disabled={locked} loading={busy || loading} data-attr="auth-phone-continue">
          {challengeId ? "Verify code" : purpose === "sign_in" ? "Text me a code" : purpose === "change_number_old" ? "Verify current number" : "Send code"}
        </Button>
      )}
      {canSkip ? (
        <Button type="button" variant="ghost" className="w-full" disabled={busy} onClick={() => void skip()} data-attr="auth-phone-skip">Skip for now</Button>
      ) : null}
      {challengeId ? (
        <div className="flex items-center justify-between gap-3">
          <Button type="button" variant="ghost" disabled={locked || resendLocked} onClick={() => submit({ resend: true })} data-attr="auth-phone-resend">
            {needsNewCode ? "Send a new code" : resendLocked ? `Resend in ${formatCountdown(secondsLeft)}` : "Resend code"}
          </Button>
          {!signInUi && purpose !== "change_number_old" ? (
            <Button type="button" variant="ghost" disabled={locked} onClick={() => { setChallengeId(null); setError(null); }}>Change number</Button>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
