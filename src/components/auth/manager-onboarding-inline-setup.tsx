"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import { coercePhoneInput, normalizeE164 } from "@/lib/phone-e164";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { assistantEmailUpsellMessage } from "@/lib/manager-assistant-email/assistant-email-eligibility-copy";
import type { ManagerAssistantEmailStatus } from "@/lib/manager-assistant-email/manager-assistant-email-status";
import type { WorkNumberOnboardingStatus } from "@/lib/sms/work-number-onboarding";

async function readApiError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

export function ManagerOnboardingPhoneSetup({
  initialPhone,
  phoneVerified,
  onUpdated,
}: {
  initialPhone: string;
  phoneVerified: boolean;
  onUpdated: (next: { phone: string | null; phoneVerifiedAt: string | null }) => void;
}) {
  const { showToast } = useAppUi();
  const [phoneInput, setPhoneInput] = useState(() => coercePhoneInput(initialPhone));
  const [codeInput, setCodeInput] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState<"send" | "verify" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sendCode = async () => {
    setError(null);
    setBusy("send");
    try {
      const res = await fetch("/api/manager/phone", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phoneInput }),
      });
      if (!res.ok) {
        setError(await readApiError(res, "Could not send the code."));
        return;
      }
      setCodeSent(true);
      setCodeInput("");
      showToast("Code sent. Check your texts.");
    } catch {
      setError("Network error. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  };

  const verifyCode = async () => {
    setError(null);
    setBusy("verify");
    try {
      const res = await fetch("/api/manager/phone", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: codeInput }),
      });
      if (!res.ok) {
        setError(await readApiError(res, "Could not verify the code."));
        return;
      }
      const body = (await res.json()) as { ok?: boolean; phone?: string };
      const verifiedAt = new Date().toISOString();
      onUpdated({ phone: body.phone ?? phoneInput, phoneVerifiedAt: verifiedAt });
      showToast("Phone verified.");
    } catch {
      setError("Network error. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  };

  if (phoneVerified) return null;

  return (
    <div className="mt-3 space-y-3 border-t border-border/70 pt-3" data-onboarding-inline="phone">
      <PhoneNumberField
        value={phoneInput}
        onChange={setPhoneInput}
        disabled={busy !== null}
        dataAttr="onboarding-verify-personal-phone"
      />
      {codeSent ? (
        <Input
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="6-digit code"
          value={codeInput}
          onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, "").slice(0, 6))}
          disabled={busy !== null}
        />
      ) : null}
      {error ? <p className="text-xs text-rose-600">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        {!codeSent ? (
          <Button
            type="button"
            variant="primary"
            className="min-h-0 h-8 rounded-full px-4 text-xs"
            disabled={busy !== null || !normalizeE164(phoneInput)}
            onClick={() => void sendCode()}
            data-attr="onboarding-verify-personal-phone-send"
          >
            {busy === "send" ? "Sending…" : "Send code"}
          </Button>
        ) : (
          <Button
            type="button"
            variant="primary"
            className="min-h-0 h-8 rounded-full px-4 text-xs"
            disabled={busy !== null || codeInput.length < 4}
            onClick={() => void verifyCode()}
            data-attr="onboarding-verify-personal-phone-confirm"
          >
            {busy === "verify" ? "Verifying…" : "Verify phone"}
          </Button>
        )}
      </div>
    </div>
  );
}

export function ManagerOnboardingWorkNumberSetup({
  status,
  onUpdated,
}: {
  status: WorkNumberOnboardingStatus;
  onUpdated: (next: WorkNumberOnboardingStatus) => void;
}) {
  const { showToast } = useAppUi();
  const [areaCode, setAreaCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestNumber = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/manager/messaging-number", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "request_number",
          ...(areaCode.length === 3 ? { areaCode } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as WorkNumberOnboardingStatus & { error?: string };
      if (!res.ok) {
        setError(body.error ?? "Could not request a work number.");
        if (body.number || body.canRequest !== undefined) onUpdated(body);
        return;
      }
      onUpdated(body);
      showToast(
        body.number?.phoneNumber
          ? "Your PropLane work number is ready."
          : "Work number request received — carrier registration can take a little while.",
      );
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (!status.canRequest && !status.provisioningAvailable) return null;

  return (
    <div className="mt-3 space-y-3 border-t border-border/70 pt-3" data-onboarding-inline="work-number">
      <div className="max-w-44 space-y-1.5">
        <label htmlFor="onboarding-work-number-area" className="text-xs font-semibold text-muted">
          Preferred area code <span className="font-normal">(optional)</span>
        </label>
        <Input
          id="onboarding-work-number-area"
          inputMode="numeric"
          autoComplete="tel-area-code"
          maxLength={3}
          placeholder="206"
          value={areaCode}
          onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, "").slice(0, 3))}
          disabled={busy}
        />
      </div>
      {error ? <p className="text-xs text-rose-600">{error}</p> : null}
      <Button
        type="button"
        variant="primary"
        className="min-h-0 h-8 rounded-full px-4 text-xs"
        disabled={busy || (areaCode.length > 0 && areaCode.length !== 3)}
        onClick={() => void requestNumber()}
        data-attr="onboarding-set-up-work-number"
      >
        {busy ? "Requesting…" : "Request work number"}
      </Button>
    </div>
  );
}

export function ManagerOnboardingAssistantEmailSetup({
  status,
  onUpdated,
}: {
  status: ManagerAssistantEmailStatus;
  onUpdated: (next: ManagerAssistantEmailStatus) => void;
}) {
  const { showToast } = useAppUi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const upsell = !status.canRequest
    ? assistantEmailUpsellMessage(status.planTier, status.entitlement)
    : null;

  const requestAddress = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/manager/assistant-email", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "request_address" }),
      });
      const body = (await res.json().catch(() => ({}))) as ManagerAssistantEmailStatus & { error?: string };
      if (!res.ok) {
        setError(body.error ?? "Could not set up assistant email.");
        return;
      }
      onUpdated(body);
      if (body.address) showToast("Your PropLane assistant email is ready.");
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }, [onUpdated, showToast]);

  if (status.address?.trim()) return null;

  return (
    <div className="mt-3 space-y-3 border-t border-border/70 pt-3" data-onboarding-inline="assistant-email">
      {upsell ? <p className="text-xs leading-relaxed text-muted">{upsell}</p> : null}
      {error ? <p className="text-xs text-rose-600">{error}</p> : null}
      {status.canRequest ? (
        <Button
          type="button"
          variant="primary"
          className="min-h-0 h-8 rounded-full px-4 text-xs"
          disabled={busy}
          onClick={() => void requestAddress()}
          data-attr="onboarding-set-up-assistant-email"
        >
          {busy ? "Setting up…" : "Set up assistant email"}
        </Button>
      ) : null}
    </div>
  );
}
