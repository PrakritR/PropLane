"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle } from "lucide-react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import { WIZARD_LABEL_CLASS, WizardSection } from "@/components/portal/add-workspace/parts";
import { ListingWizardOverlay } from "@/components/portal/listing-wizard-v2/wizard-overlay";
import {
  ListingWorkspace,
  StepRail,
  type StepRailItem,
} from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { ManagerWorkNumberCopyControl } from "@/components/portal/pro-sms-work-number-hint";
import { coercePhoneInput, formatSmsPhoneLabel, normalizeE164 } from "@/lib/phone-e164";
import {
  formatManagerMessagingPhone,
  type ManagerMessagingNumberStatus,
} from "@/lib/sms/manager-messaging-number";
import { workNumberStatusWord } from "@/lib/sms/work-number-status";
import { WORK_CONTACT_ANNOUNCE_EVENT } from "@/lib/work-contact-announce";

const ENDPOINT = "/api/manager/messaging-number";

const STEP_IDS = ["verify-phone", "get-number", "done"] as const;
const STEP_LABELS = ["Verify your phone", "Get your work number", "Done"] as const;

export function inferredUsAreaCode(phone: unknown): string {
  const digits = typeof phone === "string" ? phone.replace(/\D/g, "") : "";
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1, 4);
  return digits.length === 10 ? digits.slice(0, 3) : "";
}

async function readApiError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

function workspaceNumberPhone(
  status: ManagerMessagingNumberStatus,
  workspaceId: string,
): string | null {
  const workspace = status.workspaces?.find((w) => w.workspaceId === workspaceId);
  if (workspace) {
    const entry = workspace.numbers?.find((n) => n.isPrimary);
    const phone = entry?.phoneNumber?.trim() || null;
    if (phone) return phone;
    if (Array.isArray(workspace.numbers) && workspace.numbers.length === 0) return null;
  }
  if (status.workspace?.id === workspaceId && status.number?.phoneNumber?.trim()) {
    return status.number.phoneNumber.trim();
  }
  return null;
}

function numberStillProvisioning(
  status: ManagerMessagingNumberStatus,
  workspaceId: string,
): boolean {
  const workspace = status.workspaces?.find((w) => w.workspaceId === workspaceId);
  const entry = workspace?.numbers?.find((n) => n.isPrimary);
  if (entry) {
    return (
      entry.provisionState === "pending_registration" || entry.provisionState === "provisioning"
    );
  }
  if (
    workspace &&
    Array.isArray(workspace.numbers) &&
    workspace.numbers.length === 0
  ) {
    return false;
  }
  if (status.workspace?.id === workspaceId && status.number) {
    const state = status.number.state;
    return state === "pending_registration" || state === "provisioning";
  }
  return false;
}

/** First incomplete step when the popup opens or status changes. */
export function resolveWorkNumberSetupStepIndex(
  status: ManagerMessagingNumberStatus,
  workspaceId: string,
): number {
  const verified = Boolean(status.personalPhone.verifiedAt);
  if (!verified) return 0;
  const phone = workspaceNumberPhone(status, workspaceId);
  if (!phone && numberStillProvisioning(status, workspaceId)) return 1;
  if (!phone) return 1;
  return 2;
}

function WorkNumberResidentPreview({ phone }: { phone: string | null }) {
  const display = phone ? formatManagerMessagingPhone(phone) : "Your work number";
  const sample = phone
    ? `Hi! You can reach me at ${display} for maintenance and leasing questions.`
    : "Hi! You can text your property manager on their PropLane work number.";
  return (
    <section data-attr="work-number-setup-resident-preview">
      <h3 className="mb-2 text-[11.5px] font-bold uppercase tracking-[0.06em] text-muted">
        What residents see
      </h3>
      <div className="rounded-2xl border border-border bg-card p-4">
        <p className="text-[12.5px] font-bold text-foreground">{display}</p>
        <div className="mt-4 flex justify-end">
          <div
            className="portal-inbox-outbound-bubble max-w-[min(100%,18rem)] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed text-white"
            data-inbox-bubble-kind="outbound"
          >
            {sample}
          </div>
        </div>
      </div>
    </section>
  );
}

function PhoneVerifyStep({
  verifiedPhone,
  verifiedAt,
  onVerified,
}: {
  verifiedPhone: string | null;
  verifiedAt: string | null;
  onVerified: (phone: string, verifiedAt: string) => void;
}) {
  const { showToast } = useAppUi();
  const [editing, setEditing] = useState(false);
  const [phoneInput, setPhoneInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState<"send" | "verify" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/manager/phone", { credentials: "include" })
      .then(async (res) => (res.ok ? ((await res.json()) as {
        phone?: string | null;
        phoneVerifiedAt?: string | null;
        pendingVerification?: { phone: string } | null;
      }) : null))
      .then((data) => {
        if (!active || !data) return;
        if (data.phoneVerifiedAt && data.phone && data.phoneVerifiedAt !== verifiedAt) {
          onVerified(data.phone, data.phoneVerifiedAt);
          return;
        }
        const pending = data.pendingVerification;
        if (pending?.phone) {
          setPhoneInput((current) => current || coercePhoneInput(pending.phone));
          setCodeSent(true);
        } else if (data.phone) {
          setPhoneInput((current) => current || coercePhoneInput(data.phone));
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [onVerified, verifiedAt]);

  const verified = Boolean(verifiedAt) && !editing;

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
      const phone = body.phone ?? phoneInput;
      const at = new Date().toISOString();
      onVerified(phone, at);
      setEditing(false);
      setCodeSent(false);
      setCodeInput("");
      showToast("Phone verified.");
    } catch {
      setError("Network error. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  };

  if (verified) {
    return (
      <WizardSection title="Verify your phone" dataAttr="work-number-setup-verify">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className={WIZARD_LABEL_CLASS}>Mobile number</p>
            <p className="font-mono text-[15px] font-semibold text-foreground">
              {formatSmsPhoneLabel(verifiedPhone) || verifiedPhone || "—"}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            data-attr="work-number-setup-verify-change"
            onClick={() => {
              setPhoneInput(coercePhoneInput(verifiedPhone));
              setCodeInput("");
              setCodeSent(false);
              setError(null);
              setEditing(true);
            }}
          >
            Change
          </Button>
        </div>
      </WizardSection>
    );
  }

  return (
    <WizardSection title="Verify your phone" dataAttr="work-number-setup-verify">
      <div className="space-y-4">
        <div>
          <label className={WIZARD_LABEL_CLASS} htmlFor="work-number-setup-mobile">
            Mobile number
          </label>
          <PhoneNumberField
            id="work-number-setup-mobile"
            value={phoneInput}
            onChange={setPhoneInput}
            disabled={busy !== null}
            dataAttr="work-number-setup-mobile"
          />
        </div>
        {codeSent ? (
          <div>
            <label className={WIZARD_LABEL_CLASS} htmlFor="work-number-setup-code">
              6-digit code
            </label>
            <Input
              id="work-number-setup-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, ""))}
              disabled={busy !== null}
              data-attr="work-number-setup-code"
            />
          </div>
        ) : null}
        {error ? (
          <p className="text-sm font-medium text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {!codeSent ? (
            <Button
              type="button"
              variant="primary"
              disabled={busy !== null || !normalizeE164(phoneInput)}
              aria-busy={busy === "send"}
              onClick={() => void sendCode()}
              data-attr="work-number-setup-send-code"
            >
              {busy === "send" ? "Sending…" : "Send code"}
            </Button>
          ) : (
            <Button
              type="button"
              variant="primary"
              disabled={busy !== null || codeInput.length !== 6}
              aria-busy={busy === "verify"}
              onClick={() => void verifyCode()}
              data-attr="work-number-setup-verify-code"
            >
              {busy === "verify" ? "Verifying…" : "Verify"}
            </Button>
          )}
        </div>
      </div>
    </WizardSection>
  );
}

export function WorkNumberSetupModal({
  open,
  onClose,
  workspaceId,
  workspaceName,
  status,
  planMessage,
  unverifiedEntitlement,
  onStatusChange,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  workspaceName: string;
  status: ManagerMessagingNumberStatus;
  planMessage: string | null;
  unverifiedEntitlement: boolean;
  onStatusChange: (next: ManagerMessagingNumberStatus) => void;
}) {
  const { showToast } = useAppUi();
  const [stepIndex, setStepIndex] = useState(0);
  const [areaCode, setAreaCode] = useState("");
  const [requestBusy, setRequestBusy] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [personalVerifiedAt, setPersonalVerifiedAt] = useState<string | null>(
    status.personalPhone.verifiedAt,
  );
  const [personalPhone, setPersonalPhone] = useState<string | null>(status.personalPhone.phone);

  useEffect(() => {
    if (!open) return;
    setStepIndex(resolveWorkNumberSetupStepIndex(status, workspaceId));
    setAreaCode((current) => current || inferredUsAreaCode(status.personalPhone.phone));
    setRequestError(null);
    setPersonalVerifiedAt(status.personalPhone.verifiedAt);
    setPersonalPhone(status.personalPhone.phone);
  }, [open, status, workspaceId]);

  const assignedPhone = workspaceNumberPhone(status, workspaceId);
  const provisioning = numberStillProvisioning(status, workspaceId);

  useEffect(() => {
    if (!open || !provisioning) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void fetch(`${ENDPOINT}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        credentials: "include",
        cache: "no-store",
      })
        .then(async (res) => (res.ok ? ((await res.json()) as ManagerMessagingNumberStatus) : null))
        .then((body) => {
          if (body) onStatusChange(body);
        })
        .catch(() => {});
    }, 12_000);
    return () => window.clearInterval(interval);
  }, [open, provisioning, workspaceId, onStatusChange]);

  useEffect(() => {
    if (!open) return;
    if (assignedPhone && stepIndex < 2) setStepIndex(2);
  }, [assignedPhone, open, stepIndex]);

  const phoneVerified = Boolean(personalVerifiedAt);

  const railSteps = useMemo((): StepRailItem[] => {
    const verifyDone = phoneVerified;
    const numberDone = Boolean(assignedPhone);
    return STEP_IDS.map((id, index) => ({
      id,
      label: STEP_LABELS[index]!,
      done: index === 0 ? verifyDone : index === 1 ? numberDone : numberDone,
      disabled: index === 2 && !numberDone,
    }));
  }, [assignedPhone, phoneVerified]);

  const onJump = useCallback(
    (index: number) => {
      if (index === 2 && !assignedPhone) return;
      if (index === 1 && !phoneVerified) return;
      setStepIndex(index);
    },
    [assignedPhone, phoneVerified],
  );

  const onPhoneVerified = useCallback(
    (phone: string, verifiedAt: string) => {
      setPersonalPhone(phone);
      setPersonalVerifiedAt(verifiedAt);
      setAreaCode((current) => current || inferredUsAreaCode(phone));
      onStatusChange({
        ...status,
        personalPhone: {
          ...status.personalPhone,
          phone,
          verifiedAt,
        },
      });
    },
    [onStatusChange, status],
  );

  const requestNumber = useCallback(async () => {
    if (planMessage && !unverifiedEntitlement) return;
    setRequestError(null);
    setRequestBusy(true);
    try {
      const res = await fetch(`${ENDPOINT}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "request_number",
          ...(areaCode.length === 3 ? { areaCode } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as ManagerMessagingNumberStatus & {
        error?: string;
      };
      if (!res.ok) {
        if (body && typeof body === "object" && "mode" in body) onStatusChange(body);
        setRequestError(body.error ?? "Could not request a messaging number.");
        return;
      }
      onStatusChange(body);
      const phone =
        typeof body.number?.phoneNumber === "string" ? body.number.phoneNumber.trim() : "";
      if (phone || body.number?.state === "pending_registration" || body.number?.state === "provisioning") {
        setStepIndex(phone ? 2 : 1);
      }
      if (phone) {
        showToast(
          body.canSend
            ? "Messaging number ready."
            : "Messaging number assigned. Carrier registration may still be finishing.",
        );
      }
    } catch {
      setRequestError("Network error. Check your connection and try again.");
    } finally {
      setRequestBusy(false);
    }
  }, [
    areaCode,
    onStatusChange,
    planMessage,
    showToast,
    unverifiedEntitlement,
    workspaceId,
  ]);

  const statusWord = useMemo(() => {
    if (!status.number || status.workspace?.id !== workspaceId) {
      const workspace = status.workspaces?.find((w) => w.workspaceId === workspaceId);
      const entry = workspace?.numbers?.find((n) => n.isPrimary);
      if (entry) return workNumberStatusWord({ state: entry.provisionState });
      return provisioning ? "Setting up" : "Not set up";
    }
    return workNumberStatusWord({
      state: status.number.state,
      carrierRegistrationState: status.number.carrierRegistrationState,
      setupNeedsAttention: status.number.setupNeedsAttention,
      canSend: status.canSend,
    });
  }, [provisioning, status, workspaceId]);

  const previewPhone = assignedPhone;

  const goBack = () => {
    if (stepIndex > 0) setStepIndex(stepIndex - 1);
  };

  const primaryDisabled =
    stepIndex === 0
      ? !phoneVerified
      : stepIndex === 1
        ? requestBusy ||
          (Boolean(planMessage) && !unverifiedEntitlement) ||
          (areaCode.length > 0 && areaCode.length !== 3)
        : false;

  const primaryLabel =
    stepIndex === 0
      ? "Continue"
      : stepIndex === 1
        ? requestBusy
          ? "Requesting…"
          : "Request number"
        : "Done";

  const primaryAction = () => {
    if (stepIndex === 0) {
      if (phoneVerified) setStepIndex(1);
      return;
    }
    if (stepIndex === 1) {
      void requestNumber();
      return;
    }
    onClose();
  };

  if (!open) return null;

  return (
    <ListingWizardOverlay ariaLabel="Set up a work number">
      <ListingWorkspace
        title="Set up a work number"
        onClose={onClose}
        closeDataAttr="add-work-number-modal-close"
        previewInEye
        rail={
          <StepRail
            steps={railSteps}
            current={stepIndex}
            onJump={onJump}
            visited={new Set(STEP_IDS.filter((_, i) => i <= stepIndex))}
          />
        }
        railHeader={
          <div
            className="mb-3 rounded-xl border border-border bg-white px-3 py-3 [html[data-theme=dark]_&]:bg-card"
            data-attr="work-number-setup-workspace-context"
          >
            <p className="text-[11.5px] font-bold uppercase tracking-[0.06em] text-muted">Workspace</p>
            <p className="mt-1 text-[15px] font-bold text-foreground">{workspaceName}</p>
          </div>
        }
        sidePanel={<WorkNumberResidentPreview phone={assignedPhone ?? previewPhone} />}
        footer={
          <>
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                disabled={stepIndex === 0 || requestBusy}
                hidden={stepIndex === 0}
                onClick={goBack}
                data-attr="work-number-setup-back"
                className="min-h-[44px] rounded-full border border-border bg-card px-6 text-[14px] font-bold text-foreground disabled:opacity-45"
              >
                Back
              </button>
            </div>
            <span className="min-w-0 flex-1 text-center text-[12.5px] text-muted">
            </span>
            <button
              type="button"
              disabled={primaryDisabled}
              aria-busy={stepIndex === 1 && requestBusy}
              onClick={primaryAction}
              data-attr={
                stepIndex === 1 ? "add-work-number-submit" : stepIndex === 2 ? "work-number-setup-done" : "work-number-setup-continue"
              }
              className="min-h-[44px] rounded-full bg-primary px-7 text-[14px] font-bold text-white disabled:opacity-60"
            >
              {primaryLabel}
            </button>
          </>
        }
      >
        {stepIndex === 0 ? (
          <PhoneVerifyStep
            verifiedPhone={personalPhone}
            verifiedAt={personalVerifiedAt}
            onVerified={onPhoneVerified}
          />
        ) : null}
        {stepIndex === 1 ? (
          <WizardSection title="Get your work number" dataAttr="work-number-setup-request">
            {planMessage ? (
              <div
                className="mb-4 space-y-3 rounded-xl border border-[var(--status-overdue-fg)]/40 bg-[var(--status-overdue-bg)] px-3 py-3"
                data-attr="messaging-work-number-plan-lock"
                role="alert"
              >
                <div className="flex items-start gap-2 text-sm text-[var(--status-overdue-fg)]">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <p className="font-medium leading-relaxed">{planMessage}</p>
                </div>
                {unverifiedEntitlement ? null : (
                  <Button asChild variant="primary" data-attr="messaging-open-billing">
                    <Link
                      href={
                        !status.entitlement.eligible && status.entitlement.reason === "trialing"
                          ? "/portal/profile?tab=billing&activatePaid=1"
                          : "/portal/profile?tab=billing"
                      }
                    >
                      {!status.entitlement.eligible && status.entitlement.reason === "trialing"
                        ? "Start Pro"
                        : "Upgrade to a paid plan"}
                    </Link>
                  </Button>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className={WIZARD_LABEL_CLASS} htmlFor="messaging-number-area-code">
                    Preferred area code
                  </label>
                  <Input
                    id="messaging-number-area-code"
                    inputMode="numeric"
                    autoComplete="tel-area-code"
                    maxLength={3}
                    placeholder="206"
                    value={areaCode}
                    onChange={(event) => setAreaCode(event.target.value.replace(/\D/g, "").slice(0, 3))}
                    disabled={requestBusy}
                    data-attr="add-work-number-area-code"
                  />
                </div>
                {provisioning && !assignedPhone ? (
                  <p className="text-sm font-medium text-foreground" role="status">
                    Setting up your work number…
                  </p>
                ) : null}
                {requestError ? (
                  <p className="text-sm font-medium text-danger" role="alert">
                    {requestError}
                  </p>
                ) : null}
              </div>
            )}
          </WizardSection>
        ) : null}
        {stepIndex === 2 && assignedPhone ? (
          <WizardSection title="Done" dataAttr="work-number-setup-done-step">
            <div className="space-y-4">
              <ManagerWorkNumberCopyControl phone={assignedPhone} dataAttr="work-number-setup-copy" />
              <div>
                <p className={WIZARD_LABEL_CLASS}>Status</p>
                <p className="text-[15px] font-semibold text-foreground">{statusWord}</p>
              </div>
              <Button
                type="button"
                variant="outline"
                data-attr="work-number-setup-share"
                onClick={() => window.dispatchEvent(new CustomEvent(WORK_CONTACT_ANNOUNCE_EVENT))}
              >
                Share with residents
              </Button>
            </div>
          </WizardSection>
        ) : null}
      </ListingWorkspace>
    </ListingWizardOverlay>
  );
}
