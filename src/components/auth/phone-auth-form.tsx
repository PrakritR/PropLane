"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAuthWelcomeChrome } from "@/components/auth/use-auth-welcome-chrome";
import { Input } from "@/components/ui/input";
import { oauthContinuePath } from "@/lib/auth/oauth-redirect";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

type Purpose = "sign_in" | "verify_phone" | "change_number_old" | "change_number_new";
type PhoneStatus = { enabled: boolean; verified: boolean; phone: string | null; needsOldNumber: boolean };
type PhoneResponse = {
  error?: string;
  challengeId?: string;
  ok?: boolean;
  next?: string;
  oldNumberVerified?: boolean;
  session?: { access_token: string; refresh_token: string };
};

const REQUEST_ERROR = "Could not verify your phone. Please try again.";

export function PhoneAuthForm({
  mode = "sign_in",
  nextPath = "",
  disabled = false,
  onBusyChange,
}: {
  mode?: "sign_in" | "verify_phone";
  nextPath?: string;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
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
  const inFlight = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);

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
    if (!response.ok || result.error) throw new Error(result.error || REQUEST_ERROR);
    return result;
  };

  const submit = async (resend = false) => {
    if (disabled || loading || statusFailed || inFlight.current) return;
    const fields = new FormData(formRef.current!);
    // WebKit AutoFill may update the DOM without firing React's onChange.
    const submittedPhone = purpose === "change_number_old" ? phone : String(fields.get("phone") ?? "").trim();
    const code = String(fields.get("code") ?? "").trim();
    if ((!challengeId || resend) && !submittedPhone) {
      setError("Enter your phone number.");
      return;
    }
    if (challengeId && !resend && !/^\d{6}$/.test(code)) {
      setError("Enter the 6-digit code.");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    try {
      if (!challengeId || resend) {
        const result = await request("/api/auth/phone/start", { phone: submittedPhone, purpose });
        if (!result.challengeId) throw new Error(REQUEST_ERROR);
        setPhone(submittedPhone);
        setChallengeId(result.challengeId);
        const codeField = formRef.current?.elements.namedItem("code") as HTMLInputElement | null;
        if (codeField) codeField.value = "";
      } else {
        const result = await request("/api/auth/phone/verify", { challengeId, code });
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
        window.location.replace(oauthContinuePath(nextPath || result.next || ""));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : REQUEST_ERROR);
    } finally {
      inFlight.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  };

  const locked = disabled || busy || loading || statusFailed;
  const phoneLabel = purpose === "change_number_old" ? "Current phone number" : purpose === "change_number_new" ? "New phone number" : "Phone number";
  return (
    <form ref={formRef} className="space-y-3" aria-label="Phone verification" onSubmit={(event) => {
      event.preventDefault();
      void submit();
    }}>
      <label htmlFor="auth-phone-number" className="block text-sm font-medium text-foreground">{phoneLabel}</label>
      <Input id="auth-phone-number" name="phone" type="tel" autoComplete="tel" inputMode="tel"
        placeholder="+1 (555) 555-0123" value={phone} onChange={(event) => { setPhone(event.target.value); setError(null); }}
        readOnly={Boolean(challengeId) || purpose === "change_number_old"} disabled={locked}
        aria-describedby={error ? "auth-phone-error" : undefined} />
      {challengeId ? (
        <div className="space-y-2">
          <label htmlFor="auth-phone-code" className="block text-sm font-medium text-foreground">Verification code</label>
          <Input key={challengeId} id="auth-phone-code" name="code" type="text" inputMode="numeric"
            autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} placeholder="6-digit code"
            autoFocus disabled={locked} aria-describedby={error ? "auth-phone-error" : undefined} />
        </div>
      ) : null}
      {error ? <p id="auth-phone-error" role="alert" className="text-sm text-danger">{error}</p> : null}
      {statusFailed ? (
        <Button type="button" variant="secondary" className="w-full" onClick={() => {
          setLoading(true); setStatusFailed(false); setError(null); setStatusVersion((value) => value + 1);
        }}>Try again</Button>
      ) : (
        <Button type="submit" className="btn-cobalt w-full rounded-full py-2.5 text-[15px] font-semibold"
          disabled={locked} loading={busy || loading} data-attr="auth-phone-continue">
          {challengeId ? "Verify code" : purpose === "sign_in" ? "Continue with phone" : purpose === "change_number_old" ? "Verify current number" : "Send code"}
        </Button>
      )}
      {challengeId ? (
        <div className="flex items-center justify-between gap-3">
          <Button type="button" variant="ghost" disabled={locked} onClick={() => submit(true)}>Resend code</Button>
          {purpose !== "change_number_old" ? (
            <Button type="button" variant="ghost" disabled={locked} onClick={() => { setChallengeId(null); setError(null); }}>Change number</Button>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
