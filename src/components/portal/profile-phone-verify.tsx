"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatSmsPhoneLabel } from "@/lib/phone-e164";

const FALLBACK_ERROR = "We couldn't verify this number. Try again.";

async function postPhone(step: "start" | "verify", body: Record<string, unknown>) {
  // Literal paths (not a template): the route-resolution guard reads them as written.
  const res = await fetch(step === "start" ? "/api/auth/phone/start" : "/api/auth/phone/verify", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, purpose: "verify_own_phone" }),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; challengeId?: string };
  return { ok: res.ok, data };
}

/**
 * Settings > Profile > Phone "Verify". Texts a code to the number saved on the signed-in account (the server picks
 * the number from the session, never from this request) and confirms it. Works whatever the rollout switches say.
 */
export function useProfilePhoneVerify({ phone, onVerified }: { phone: string; onVerified: () => void }) {
  // The whole code step is keyed on the number it was started for: a different number is a different proof, so a
  // half-finished step for the old one simply stops applying.
  const [flow, setFlow] = useState<{ phone: string; challengeId: string | null; code: string; error: string | null }>({
    phone, challengeId: null, code: "", error: null,
  });
  const current = flow.phone === phone ? flow : { phone, challengeId: null, code: "", error: null };
  const { challengeId, code, error } = current;
  const onVerifiedRef = useRef(onVerified);
  useEffect(() => {
    onVerifiedRef.current = onVerified;
  }, [onVerified]);

  const patch = useCallback(
    (next: Partial<{ challengeId: string | null; code: string; error: string | null }>) =>
      setFlow((prev) => ({ ...(prev.phone === phone ? prev : { phone, challengeId: null, code: "", error: null }), ...next })),
    [phone],
  );

  const send = useCallback(async () => {
    patch({ error: null });
    try {
      const { ok, data } = await postPhone("start", {});
      if (!ok || !data.challengeId) {
        patch({ error: data.error ?? FALLBACK_ERROR });
        return;
      }
      patch({ code: "", challengeId: data.challengeId });
    } catch {
      patch({ error: "No connection. Try again." });
    }
  }, [patch]);

  const confirm = useCallback(async () => {
    if (!challengeId) return;
    patch({ error: null });
    try {
      const { ok, data } = await postPhone("verify", { challengeId, code });
      if (!ok) {
        patch({ error: data.error ?? FALLBACK_ERROR });
        return;
      }
      patch({ challengeId: null, code: "" });
      onVerifiedRef.current();
    } catch {
      patch({ error: "No connection. Try again." });
    }
  }, [challengeId, code, patch]);

  const setCode = useCallback((next: string) => patch({ code: next }), [patch]);

  return { codeSent: challengeId !== null, code, setCode, error, send, confirm };
}

/** The ghost "Verify" button that sits on the Phone row while the saved number is unverified. */
export function ProfilePhoneVerifyButton({ onSend }: { onSend: () => Promise<void> }) {
  return (
    <Button type="button" variant="ghost" onClick={() => onSend()} data-attr="settings-verify-phone">
      Verify
    </Button>
  );
}

/** The second row: where the code went, a 6-digit input and Confirm. Errors show inline in the row. */
export function ProfilePhoneCodeRow({
  phone,
  code,
  onCodeChange,
  error,
  onConfirm,
}: {
  phone: string;
  code: string;
  onCodeChange: (code: string) => void;
  error: string | null;
  onConfirm: () => Promise<void>;
}) {
  return (
    <div className="border-b border-border px-4 py-3.5 last:border-0" data-attr="profile-phone-code-row">
      <div className="flex min-h-11 items-center justify-between gap-4">
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          Code sent to {formatSmsPhoneLabel(phone) || phone}
        </span>
        <div className="flex items-center gap-2">
          <Input
            value={code}
            onChange={(event) => onCodeChange(event.target.value.replace(/\D/g, "").slice(0, 6))}
            onKeyDown={(event) => {
              if (event.key === "Enter" && code.length === 6) void onConfirm();
            }}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            aria-label="6-digit code"
            data-attr="settings-phone-code"
            className="h-9 w-32 rounded-lg text-center tracking-widest"
          />
          <Button
            type="button"
            variant="primary"
            disabled={code.length !== 6}
            onClick={() => onConfirm()}
            data-attr="settings-confirm-phone-code"
          >
            Confirm
          </Button>
        </div>
      </div>
      {error ? <p className="mt-1 text-sm text-danger" role="alert">{error}</p> : null}
    </div>
  );
}
