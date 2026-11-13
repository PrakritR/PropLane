"use client";

/**
 * One manager-added resident's way into the portal: link sent, opened, account created, lease signed, first payment.
 * Read from the record by the server on open; Resend email / Resend text are the same actions the bulk bar has.
 */
import { useCallback, useEffect, useState } from "react";
import { Check, Circle } from "lucide-react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import type { OnboardingStep } from "@/lib/resident-onboarding-link/status";

type Status = { name: string; hasPhone: boolean; hasEmail: boolean; steps: OnboardingStep[] };

function when(at: string | null): string {
  if (!at) return "";
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ResidentSetupProgressModal({ applicationId, residentName, onClose }: { applicationId: string | null; residentName: string; onClose: () => void }) {
  const { showToast } = useAppUi();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"email" | "text" | null>(null);

  const load = useCallback(async () => {
    if (!applicationId) return;
    try {
      const res = await fetch(`/api/portal/resident-onboarding-status?applicationId=${encodeURIComponent(applicationId)}`, { credentials: "include", cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as Status & { error?: string };
      if (!res.ok) setError(data.error ?? "Could not read this resident.");
      else {
        setStatus(data);
        setError(null);
      }
    } catch {
      setError("Could not read this resident.");
    }
  }, [applicationId]);

  useEffect(() => {
    setStatus(null);
    setError(null);
    void load();
  }, [load]);

  const resend = async (channel: "email" | "text") => {
    if (!applicationId || busy) return;
    setBusy(channel);
    try {
      const res =
        channel === "email"
          ? await fetch("/api/portal/onboard-existing-resident", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ applicationId, sendWelcomeEmail: true, viaEmail: true, viaSms: false, viaInbox: true }) })
          : await fetch("/api/portal/resident-onboarding-link", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ applicationId }) });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      showToast(res.ok && data.ok !== false ? (channel === "email" ? "Link emailed again." : "Link texted again.") : (data.error ?? "Could not send the link."));
      await load();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      open={Boolean(applicationId)}
      title={`${residentName || status?.name || "Resident"} setup`}
      onClose={onClose}
      dataAttr="resident-setup-progress"
      contextPanel={null}
      preview={null}
      footer={
        <ModalFooter>
          <Button type="button" variant="outline" disabled={busy !== null || !status?.hasEmail} onClick={() => void resend("email")} data-attr="resident-setup-resend-email">
            {busy === "email" ? "Sending…" : "Resend email"}
          </Button>
          <Button type="button" variant="outline" disabled={busy !== null || !status?.hasPhone} onClick={() => void resend("text")} data-attr="resident-setup-resend-text">
            {busy === "text" ? "Sending…" : "Resend text"}
          </Button>
        </ModalFooter>
      }
    >
      {error ? (
        <p className="text-sm text-red-700">{error}</p>
      ) : !status ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <ol className="space-y-3" data-attr="resident-setup-steps">
          {status.steps.map((step) => (
            <li key={step.id} className="flex items-center gap-3 text-sm" data-step={step.id} data-done={step.done}>
              {step.done ? <Check className="size-4 text-emerald-600" aria-hidden /> : <Circle className="size-4 text-muted" aria-hidden />}
              <span className={step.done ? "font-semibold" : "text-muted"}>{step.label}</span>
              {step.done && step.at ? <span className="ml-auto text-muted tabular-nums">{when(step.at)}</span> : null}
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}
