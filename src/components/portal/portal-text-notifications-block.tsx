"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  PortalSettingsFormBody,
  PortalSettingsGroup,
  PortalSettingsSection,
} from "@/components/portal/portal-settings-ui";
import { useAppUi } from "@/components/providers/app-ui-provider";

type TextNotificationSettings = {
  phone: string | null;
  phoneVerifiedAt: string | null;
  smsConfigured: boolean;
  /** An unexpired code the server has already sent, if any. */
  pendingVerification?: { phone: string; expiresAt: string } | null;
};

const SAFE_DEFAULTS: TextNotificationSettings = {
  phone: null,
  phoneVerifiedAt: null,
  smsConfigured: false,
  pendingVerification: null,
};

async function readApiError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Reusable "Text notifications" verification block for residents and vendors.
 *
 * Reuses the user-generic `/api/manager/phone` route (POST send code → PUT
 * confirm) — the SAME endpoint the manager panel uses — so a resident/vendor
 * can verify their phone and receive SMS notifications. Demo mode simulates the
 * flow without touching the real API.
 */
export function PortalTextNotificationsBlock({
  dataAttrPrefix,
  demo = false,
  title = "Text notifications",
  description = "Verify your mobile number to get maintenance and message updates by text.",
  onVerified,
}: {
  /** Kebab prefix for data-attr hooks, e.g. "resident" / "vendor". */
  dataAttrPrefix: string;
  /** Demo sandbox: simulate the flow instead of hitting the real API. */
  demo?: boolean;
  title?: string;
  description?: string;
  onVerified?: (settings: TextNotificationSettings) => void;
}) {
  const { showToast } = useAppUi();
  const [settings, setSettings] = useState<TextNotificationSettings | null>(() =>
    demo ? { phone: null, phoneVerifiedAt: null, smsConfigured: true } : null,
  );
  const [editingPhone, setEditingPhone] = useState(false);
  const [phoneInput, setPhoneInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState<"send" | "verify" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const finishVerification = useCallback(
    (phone: string) => {
      const next = {
        ...(settings ?? SAFE_DEFAULTS),
        phone,
        phoneVerifiedAt: new Date().toISOString(),
      };
      setSettings(next);
      setEditingPhone(false);
      setCodeSent(false);
      setCodeInput("");
      setPhoneInput("");
      setError(null);
      onVerified?.(next);
    },
    [onVerified, settings],
  );

  useEffect(() => {
    if (demo) {
      return;
    }
    let active = true;
    void fetch("/api/manager/phone", { credentials: "include" })
      .then(async (res) =>
        res.ok ? ((await res.json()) as TextNotificationSettings) : SAFE_DEFAULTS,
      )
      .catch(() => SAFE_DEFAULTS)
      .then((data) => {
        if (!active) return;
        setSettings(data);
        // `codeSent` is client-only, so a reload after "Send code" would hide
        // the code box while the resend throttle still refuses a new code.
        // Reopen it for a code the server says is still live.
        const pending = data.pendingVerification;
        if (pending?.phone && !data.phoneVerifiedAt) {
          setPhoneInput((current) => current || pending.phone);
          setCodeSent(true);
        } else if (data.phone && !data.phoneVerifiedAt) {
          // The number is already on the profile — do not make them type it a
          // second time. Verification still stands: this prefills the field,
          // it does not skip the code, because a number on file is not proof
          // the person holds that handset.
          setPhoneInput((current) => current || data.phone!);
        }
      });
    return () => {
      active = false;
    };
  }, [demo]);

  const sendCode = async () => {
    setError(null);
    if (demo) {
      setCodeSent(true);
      setCodeInput("");
      showToast("Code sent (simulated in this demo).");
      return;
    }
    setBusy("send");
    try {
      const res = await fetch("/api/manager/phone", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phoneInput }),
      });
      if (!res.ok) {
        const message = await readApiError(res, "Could not send the code.");
        setError(message);
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
    if (demo) {
      finishVerification(phoneInput);
      showToast("Phone verified (simulated in this demo).");
      return;
    }
    setBusy("verify");
    try {
      const res = await fetch("/api/manager/phone", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: codeInput }),
      });
      if (!res.ok) {
        const message = await readApiError(res, "Could not verify the code.");
        setError(message);
        return;
      }
      const body = (await res.json()) as { ok?: boolean; phone?: string };
      finishVerification(body.phone ?? phoneInput);
      showToast("Phone verified.");
    } catch {
      setError("Network error. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  };

  const verified = Boolean(settings?.phoneVerifiedAt) && !editingPhone;
  const smsConfigured = settings?.smsConfigured ?? false;

  return (
    <PortalSettingsSection
      title={title}
      description={description}
    >
      <PortalSettingsGroup>
        <PortalSettingsFormBody className="space-y-3">
      {settings === null ? (
        <div className="space-y-3 py-1" aria-label="Loading phone verification settings">
          <div className="h-4 w-44 animate-pulse rounded bg-accent motion-reduce:animate-none" />
          <div className="h-10 w-full max-w-80 animate-pulse rounded-lg bg-accent motion-reduce:animate-none" />
        </div>
      ) : verified ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <p className="text-sm font-semibold text-foreground">Mobile number</p>
            <span className="font-mono text-sm text-foreground">{settings.phone}</span>
            <Badge tone="success">Verified</Badge>
          </div>
          <Button
            type="button"
            variant="outline"
            className="h-10 min-h-10 shrink-0 rounded-full px-3 text-xs"
            data-attr={`${dataAttrPrefix}-text-notifications-change`}
            onClick={() => {
              setPhoneInput("");
              setCodeInput("");
              setCodeSent(false);
              setError(null);
              setEditingPhone(true);
            }}
          >
            Change
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="space-y-2">
            <label
              className="text-xs font-semibold text-muted"
              htmlFor={`${dataAttrPrefix}-text-notifications-phone`}
            >
              Mobile number
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id={`${dataAttrPrefix}-text-notifications-phone`}
                className="max-w-56"
                placeholder="(206) 555-0123"
                inputMode="tel"
                autoComplete="tel"
                type="tel"
                value={phoneInput}
                onChange={(e) => setPhoneInput(e.target.value)}
                disabled={busy !== null || !smsConfigured}
              />
              <Button
                type="button"
                variant="outline"
                className="h-10 min-h-10 shrink-0 rounded-full px-4 text-xs"
                data-attr={`${dataAttrPrefix}-text-notifications-send-code`}
                disabled={busy !== null || !smsConfigured || !phoneInput.trim()}
                onClick={() => sendCode()}
              >
                {busy === "send" ? "Sending…" : codeSent ? "Resend code" : "Send code"}
              </Button>
            </div>
          </div>
          {codeSent ? (
            <div className="space-y-2">
              <label
                className="text-xs font-semibold text-muted"
                htmlFor={`${dataAttrPrefix}-text-notifications-code`}
              >
                6-digit code
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id={`${dataAttrPrefix}-text-notifications-code`}
                  className="max-w-36 font-mono"
                  placeholder="123456"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={codeInput}
                  onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, ""))}
                  disabled={busy !== null}
                />
                <Button
                  type="button"
                  variant="primary"
                  className="h-10 min-h-10 shrink-0 rounded-full px-4 text-xs"
                  data-attr={`${dataAttrPrefix}-text-notifications-verify`}
                  disabled={busy !== null || codeInput.length !== 6}
                  onClick={() => verifyCode()}
                >
                  {busy === "verify" ? "Verifying…" : "Verify"}
                </Button>
              </div>
            </div>
          ) : null}
          {error ? (
            <p className="text-xs font-medium text-danger" role="alert">
              {error}
            </p>
          ) : null}
          {smsConfigured ? null : (
            <p className="text-xs text-muted">
              Text notifications aren&apos;t available yet. They&apos;ll turn on once your property
              manager connects texting.
            </p>
          )}
        </div>
      )}
        </PortalSettingsFormBody>
      </PortalSettingsGroup>
    </PortalSettingsSection>
  );
}
