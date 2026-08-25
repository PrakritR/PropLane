"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  DEFAULT_APPLICATION_AUTOMATION,
  normalizeApplicationAutomation,
  type ApplicationAutomationPreferences,
  type ApplicationAutomationStep,
} from "@/lib/application-automation-preferences";

/** Ordered as the work happens: approve, then generate, then send. */
const AUTOMATION_CONTROLS: {
  step: ApplicationAutomationStep;
  label: string;
  hint: string;
}[] = [
  {
    step: "autoApproveApplications",
    label: "Auto-approve applications",
    hint: "Approve a submitted application without reviewing it first. Withdrawn applications are never approved.",
  },
  {
    step: "autoGenerateLease",
    label: "Auto-generate the lease on approval",
    hint: "Build the lease document as soon as an application is approved. A lease that already has a document is left alone.",
  },
  {
    step: "autoSendLease",
    label: "Auto-send the lease to the resident",
    hint: "Send the generated lease for signature. PropLane still refuses to send an unreviewed or mismatched lease.",
  },
];

/**
 * The manager's account-wide application settings: a promo code that makes an application free,
 * and the automation the manager wants PropLane to run on their behalf.
 *
 * This dialog once also set the account-wide application fee, but the fee is now authoritative
 * per listing ([app-fee-authority] option B) and the account-wide value is only a new-listing
 * default, so it no longer needs an editor here. Saving writes via
 * `/api/portal/manager-application-settings`.
 *
 * The automation toggles are ordered as the work happens — approve, then generate, then send —
 * because each later step only has anything to act on once the earlier one has run. They remain
 * INDEPENDENT switches all the same: enabling "send" does not silently enable "generate", it just
 * has nothing to send until a document exists. `shouldAutomate` enforces every gate at run time;
 * these are only the switches.
 */
export function ManagerApplicationSettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [waiverCode, setWaiverCode] = useState("");
  // The account-wide application fee is no longer edited here. We still carry its stored
  // value untouched so saving the promo code re-sends it verbatim and never clears it — the
  // PATCH route treats an omitted `applicationFeeCents` as a clear, and round 24 forbids
  // deleting stored data.
  const [feeCents, setFeeCents] = useState<number | null>(null);
  const [automation, setAutomation] = useState<ApplicationAutomationPreferences>(
    DEFAULT_APPLICATION_AUTOMATION,
  );

  const load = useCallback(async () => {
    if (demo) {
      setWaiverCode("WELCOME50");
      setFeeCents(5000);
      setAutomation(DEFAULT_APPLICATION_AUTOMATION);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/portal/manager-application-settings", { credentials: "include" });
      const data = (await res.json().catch(() => ({}))) as {
        settings?: { applicationFeeCents: number | null };
        automation?: unknown;
        waiverCode?: string | null;
        error?: string;
      };
      if (!res.ok) {
        showToast(data.error ?? "Could not load promo code.");
        return;
      }
      setFeeCents(data.settings?.applicationFeeCents ?? null);
      setAutomation(normalizeApplicationAutomation(data.automation));
      setWaiverCode((data.waiverCode ?? "").trim());
    } catch {
      showToast("Could not load promo code.");
    } finally {
      setLoading(false);
    }
  }, [demo, showToast]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function save() {
    const nextWaiver = waiverCode.trim();
    if (demo) {
      showToast("Settings saved (demo).");
      onClose();
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/portal/manager-application-settings", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        // Re-send the stored fee unchanged so this save never clears it.
        body: JSON.stringify({ applicationFeeCents: feeCents, waiverCode: nextWaiver, automation }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        showToast(data.error ?? "Could not save settings.");
        return;
      }
      showToast("Application settings saved.");
      onClose();
    } catch {
      showToast("Could not save settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Application settings"
      dense
      assistantStrip={false}
      footer={
        <ModalFooter>
          <Button
            type="button"
            className="rounded-full px-4 text-[13px]"
            onClick={() => save()}
            disabled={loading || saving}
            data-attr="manager-application-fee-save"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-5">
        <div className="space-y-2">
          <p className="text-[13px] font-semibold text-foreground">Promo code</p>
          <Input
            aria-label="Promo code"
            value={waiverCode}
            onChange={(e) => setWaiverCode(e.target.value)}
            placeholder="E.G. WELCOME50"
            data-attr="manager-application-waiver-code-input"
            disabled={loading || saving}
            className="w-full font-mono uppercase"
          />
          <p className="text-xs text-muted">Applicants entering this code apply for free. Leave empty to turn it off.</p>
        </div>

        <div className="space-y-3 border-t border-border pt-4">
          <div>
            <p className="text-[13px] font-semibold text-foreground">Automation</p>
            <p className="text-xs text-muted">
              Hand these steps to PropLane. Everything is off unless you turn it on, and every
              check that applies when you do this by hand still applies.
            </p>
          </div>
          {AUTOMATION_CONTROLS.map(({ step, label, hint }) => (
            <label key={step} className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                checked={automation[step]}
                disabled={loading || saving}
                data-attr={`manager-application-automation-${step}`}
                onChange={(e) =>
                  setAutomation((prev) => ({ ...prev, [step]: e.target.checked }))
                }
              />
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-foreground">{label}</span>
                <span className="block text-xs text-muted">{hint}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
    </Modal>
  );
}
