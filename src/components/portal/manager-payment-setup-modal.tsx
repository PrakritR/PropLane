"use client";

import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { openStripeConnectOnboarding } from "@/lib/stripe-connect-onboarding-client";
import {
  DEFAULT_MANAGER_MANUAL_PAYMENT_SETTINGS,
  MANAGER_MANUAL_PAYMENT_SETTINGS_EVENT,
  type ManagerManualPaymentSettingsView,
} from "@/lib/manager-manual-payment-settings";
import { normalizeManagerSkuTier, type ManagerSkuTier } from "@/lib/manager-access";
import type { ProServiceFeeChoice } from "@/lib/payment-policy";
import { useGmailPaymentTrack } from "@/components/portal/gmail-payment-auto-track-panel";
import {
  formatGmailPaymentsConnectError,
  isGmailPaymentsOAuthBlocked,
} from "@/lib/gmail-payments/connect-errors";
import { stripeSetupStateFromStatus, type StripeSetupState } from "@/lib/stripe-setup-state";

const DEMO_INBOX = "payments+demo-token@prop-lane.space";

type PaymentChannel = "zelle" | "venmo";

function draftFromSettings(settings: ManagerManualPaymentSettingsView | null): ManagerManualPaymentSettingsView {
  return settings ?? { ...DEFAULT_MANAGER_MANUAL_PAYMENT_SETTINGS, paymentInboxAddress: DEMO_INBOX };
}

function HubRow({
  label,
  connected,
  onLink,
  dataAttr,
  busy,
  linkLabel = "Link",
  pending = false,
  pendingLabel = "Finish setup",
  allowed,
  onAllowedChange,
  allowDataAttr,
}: {
  label: string;
  connected: boolean;
  onLink: () => void;
  dataAttr: string;
  busy?: boolean;
  linkLabel?: string;
  /** Account exists but Stripe reports it cannot yet receive money (onboarding incomplete). */
  pending?: boolean;
  pendingLabel?: string;
  /** Whether residents may use this method. */
  allowed: boolean;
  onAllowedChange: (allowed: boolean) => void;
  allowDataAttr: string;
}) {
  return (
    <div className="flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3.5">
      <label className="flex min-w-0 cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          className="h-4 w-4 shrink-0 rounded border-border"
          checked={allowed}
          onChange={(e) => onAllowedChange(e.target.checked)}
          data-attr={allowDataAttr}
        />
        <span className="text-sm font-semibold text-foreground">{label}</span>
      </label>
      {connected ? (
        <button
          type="button"
          onClick={onLink}
          data-attr={dataAttr}
          className="shrink-0 text-sm font-medium text-[var(--status-confirmed-fg)] hover:underline"
        >
          Connected · Manage
        </button>
      ) : pending ? (
        <button
          type="button"
          onClick={onLink}
          disabled={busy}
          data-attr={dataAttr}
          className="shrink-0 text-sm font-medium text-[var(--status-pending-fg)] hover:underline disabled:opacity-50"
        >
          {busy ? "Opening…" : `${pendingLabel} →`}
        </button>
      ) : (
        <button
          type="button"
          onClick={onLink}
          disabled={busy}
          data-attr={dataAttr}
          className="shrink-0 text-sm font-medium text-primary hover:underline disabled:opacity-50"
        >
          {busy ? "Opening…" : linkLabel}
        </button>
      )}
    </div>
  );
}

function ChannelPaymentSetupModal({
  channel,
  open,
  onClose,
  draft,
  setDraft,
  saving,
  onSaveContact,
  paymentInboxAddress,
  autoMarkEnabled,
  onAutoMarkChange,
  gmailStatus,
  gmailBusy,
  gmailSyncBusy,
  onLinkGmail,
  onSyncGmail,
  showToast,
  gmailConnectErrorReason,
}: {
  channel: PaymentChannel;
  open: boolean;
  onClose: () => void;
  draft: ManagerManualPaymentSettingsView;
  setDraft: Dispatch<SetStateAction<ManagerManualPaymentSettingsView>>;
  saving: boolean;
  onSaveContact: () => void;
  paymentInboxAddress?: string;
  autoMarkEnabled: boolean;
  onAutoMarkChange: (enabled: boolean) => void | Promise<void>;
  gmailStatus: ReturnType<typeof useGmailPaymentTrack>["gmailStatus"];
  gmailBusy: boolean;
  gmailSyncBusy: boolean;
  onLinkGmail: () => void;
  onSyncGmail: () => void;
  showToast: (message: string) => void;
  gmailConnectErrorReason?: string | null;
}) {
  const label = channel === "zelle" ? "Zelle" : "Venmo";
  const gmailConnectError = gmailConnectErrorReason
    ? formatGmailPaymentsConnectError(gmailConnectErrorReason)
    : null;
  const placeholder = channel === "zelle" ? "phone number (or email)" : "@username or phone";
  const filterFrom = channel === "zelle" ? "zellepay.com" : "venmo.com";
  const contact = channel === "zelle" ? draft.zelleContact : draft.venmoContact;
  const contactConnected =
    channel === "zelle"
      ? draft.zellePaymentsEnabled && draft.zelleContact.trim().length > 0
      : draft.venmoPaymentsEnabled && draft.venmoContact.trim().length > 0;

  return (
    <Modal open={open} title={`Link ${label}`} onClose={onClose} dense assistantStrip={false}>
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Five quick steps so residents can pay you with {label} and we auto-match receipts.
        </p>

        <div className="space-y-2 rounded-xl border border-border bg-card px-4 py-3">
          <p className="text-sm font-semibold text-foreground">Step 1 — Save your {label} contact</p>
          <p className="text-xs text-muted">
            {channel === "zelle" ? "Use the phone number enrolled in Zelle (or an email)." : "Residents will see this on their payment screen."}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={contact}
              onChange={(e) =>
                setDraft((prev) =>
                  channel === "zelle" ? { ...prev, zelleContact: e.target.value } : { ...prev, venmoContact: e.target.value },
                )
              }
              placeholder={placeholder}
              className="flex-1"
              data-attr={`manager-payment-${channel}-save-input`}
            />
            <Button
              type="button"
              variant="outline"
              className="shrink-0 rounded-full"
              disabled={saving || !contact.trim()}
              data-attr={`manager-payment-${channel}-save`}
              onClick={onSaveContact}
            >
              {saving ? "Saving…" : contactConnected ? "Update" : "Save"}
            </Button>
          </div>
        </div>

        <div className="space-y-2 rounded-xl border border-border bg-card px-4 py-3">
          <p className="text-sm font-semibold text-foreground">Step 2 — Turn on {label} email notifications</p>
          <p className="text-xs text-muted">
            {channel === "zelle" ? (
              <>
                In your bank&apos;s Zelle settings, enable email alerts for money received. In the Zelle app, open
                Settings → Notifications and turn on payment emails.
              </>
            ) : (
              <>
                In the Venmo app, open Settings → Notifications and enable emails for payments you receive.
              </>
            )}
          </p>
        </div>

        <div className="space-y-2 rounded-xl border border-border bg-card px-4 py-3">
          <p className="text-sm font-semibold text-foreground">Step 3 — Link Gmail (optional)</p>
          <p className="text-xs text-muted">
            We read {label} notification emails and match the <span className="font-mono">PL-</span> code and amount. If
            a resident forgets the code, we still match on the amount plus their name and property; anything we
            can&apos;t confidently match is never auto-marked — the charge stays pending for you to mark paid manually.
            Linked-Gmail receipts are checked when you tap{" "}
            <span className="font-medium">Sync now</span>. If Google blocks Link Gmail, skip to Step 4 — forwarding works
            without Google approval.
          </p>
          {gmailConnectError ? (
            <p
              className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${
                isGmailPaymentsOAuthBlocked(gmailConnectErrorReason ?? null)
                  ? "border-amber-300/80 bg-amber-50 text-amber-950 [html[data-theme=dark]_&]:border-amber-500/40 [html[data-theme=dark]_&]:bg-amber-950/40 [html[data-theme=dark]_&]:text-amber-100"
                  : "border-red-300/80 bg-red-50 text-red-900 [html[data-theme=dark]_&]:border-red-500/40 [html[data-theme=dark]_&]:bg-red-950/40 [html[data-theme=dark]_&]:text-red-100"
              }`}
            >
              {gmailConnectError}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {gmailStatus?.connected ? (
              <span className="text-sm font-medium text-[var(--status-confirmed-fg)]">
                {gmailStatus.email ?? "Connected"}
              </span>
            ) : (
              <button
                type="button"
                onClick={onLinkGmail}
                disabled={gmailBusy || gmailStatus?.configured === false}
                data-attr={`manager-payment-${channel}-gmail-link`}
                className="text-sm font-medium text-primary hover:underline disabled:opacity-50"
              >
                {gmailBusy ? "Opening…" : "Link Gmail"}
              </button>
            )}
            {gmailStatus?.connected ? (
              <Button
                type="button"
                variant="outline"
                className="h-7 rounded-full px-3 text-xs"
                disabled={gmailSyncBusy}
                data-attr={`manager-payment-${channel}-gmail-sync`}
                onClick={onSyncGmail}
              >
                {gmailSyncBusy ? "Syncing…" : "Sync now"}
              </Button>
            ) : null}
          </div>
          {gmailStatus?.configured === false ? (
            <p className="text-xs text-muted">Google sign-in is not configured on this server.</p>
          ) : null}
        </div>

        {paymentInboxAddress ? (
          <div className="space-y-3 rounded-xl border border-border bg-card px-4 py-4">
            <div>
              <p className="text-sm font-semibold text-foreground">
                Step 4 — Forward {label} receipts {gmailStatus?.connected ? "(optional)" : "(recommended)"}
              </p>
              <p className="mt-1 text-sm leading-relaxed text-muted">
                {gmailStatus?.connected
                  ? "Optional backup: also forward receipts so they are matched the moment they arrive."
                  : "Set up a Gmail filter to forward receipt emails to PropLane. This works even when Google blocks Link Gmail."}
              </p>
            </div>
            <ol className="space-y-3 text-sm leading-relaxed text-foreground">
              <li className="flex gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-bold text-foreground">
                  1
                </span>
                <span className="pt-0.5">
                  In Gmail, open <span className="font-medium">Settings</span> →{" "}
                  <span className="font-medium">Filters and Blocked Addresses</span> →{" "}
                  <span className="font-medium">Create a new filter</span>.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-bold text-foreground">
                  2
                </span>
                <div className="min-w-0 flex-1 space-y-2 pt-0.5">
                  <p>
                    Set <span className="font-medium">From</span> to:
                  </p>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <code className="block w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm font-semibold text-foreground">
                      {filterFrom}
                    </code>
                    <Button
                      type="button"
                      variant="outline"
                      className="shrink-0 rounded-full px-4 text-[13px]"
                      onClick={() =>
                        navigator.clipboard?.writeText(filterFrom).then(() => showToast("Copied."))
                      }
                    >
                      Copy
                    </Button>
                  </div>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-bold text-foreground">
                  3
                </span>
                <div className="min-w-0 flex-1 space-y-2 pt-0.5">
                  <p>
                    Choose <span className="font-medium">Forward it to</span> and use this address:
                  </p>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <code className="block w-full break-all rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm font-semibold text-foreground">
                      {paymentInboxAddress}
                    </code>
                    <Button
                      type="button"
                      variant="outline"
                      className="shrink-0 rounded-full px-4 text-[13px]"
                      data-attr={`manager-payment-${channel}-inbox-copy`}
                      onClick={() =>
                        navigator.clipboard?.writeText(paymentInboxAddress).then(() => showToast("Copied."))
                      }
                    >
                      Copy
                    </Button>
                  </div>
                </div>
              </li>
            </ol>
          </div>
        ) : null}

        <div className="space-y-2 rounded-xl border border-border bg-card px-4 py-3">
          <p className="text-sm font-semibold text-foreground">Step 5 — Auto-mark charges paid</p>
          <label className="flex cursor-pointer items-start gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={autoMarkEnabled}
              onChange={(e) => void onAutoMarkChange(e.target.checked)}
              data-attr={`manager-payment-${channel}-auto-mark`}
            />
            <span className="text-xs leading-relaxed text-muted">
              When a {label} receipt matches a charge, mark it paid automatically.
            </span>
          </label>
        </div>
      </div>
    </Modal>
  );
}

export function ManagerPaymentSetupModal({
  open,
  onClose,
  initialChannel = null,
  gmailConnectErrorReason = null,
  propertyOptions,
}: {
  open: boolean;
  onClose: () => void;
  portalBase: string;
  initialChannel?: PaymentChannel | null;
  gmailConnectErrorReason?: string | null;
  propertyOptions: { id: string; label: string }[];
}) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const [draft, setDraft] = useState<ManagerManualPaymentSettingsView>(() => draftFromSettings(null));
  const [loading, setLoading] = useState(false);
  const [stripeBusy, setStripeBusy] = useState(false);
  const [stripeState, setStripeState] = useState<StripeSetupState>("unlinked");
  const [stripeIssue, setStripeIssue] = useState<string | null>(null);
  const [savingChannel, setSavingChannel] = useState<PaymentChannel | null>(null);
  const [activeChannel, setActiveChannel] = useState<PaymentChannel | null>(null);
  const [skuTier, setSkuTier] = useState<ManagerSkuTier | null>(null);
  const [savingFeePayer, setSavingFeePayer] = useState(false);
  const [selectedPropertyIds, setSelectedPropertyIds] = useState<Set<string>>(() => new Set());
  const [propertySelectionComplete, setPropertySelectionComplete] = useState(false);

  const { gmailStatus, gmailBusy, gmailSyncBusy, linkGmail, syncGmail } = useGmailPaymentTrack({
    role: "manager",
    demo,
    showToast,
  });

  const loadStripeStatus = useCallback(async () => {
    if (demo) {
      setStripeState("ready");
      setStripeIssue(null);
      return;
    }
    try {
      const res = await fetch("/api/stripe/connect/status", { credentials: "include" });
      const body = (await res.json()) as {
        payoutsEnabled?: boolean;
        chargesEnabled?: boolean;
        transfersEnabled?: boolean;
        paymentReady?: boolean;
        connected?: boolean;
        accountId?: string | null;
        stripeError?: string | null;
        demo?: boolean;
        message?: string;
      };
      if (!res.ok) {
        setStripeState("unknown");
        setStripeIssue("Couldn't check your Stripe status. Try again.");
        return;
      }
      const nextState = stripeSetupStateFromStatus(body);
      setStripeState(nextState);
      setStripeIssue(
        nextState === "unknown"
          ? body.stripeError ?? body.message ?? "Couldn't check your Stripe status. Try again."
          : null,
      );
    } catch {
      setStripeState("unknown");
      setStripeIssue("Couldn't check your Stripe status. Try again.");
    }
  }, [demo]);

  const loadSettings = useCallback(async () => {
    if (demo) {
      setDraft(draftFromSettings({ ...DEFAULT_MANAGER_MANUAL_PAYMENT_SETTINGS, paymentInboxAddress: DEMO_INBOX }));
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/portal/manager-manual-payment-settings", { credentials: "include" });
      const data = (await res.json().catch(() => ({}))) as {
        settings?: ManagerManualPaymentSettingsView;
        error?: string;
      };
      if (!res.ok) {
        showToast(data.error ?? "Could not load payment setup.");
        return;
      }
      setDraft(draftFromSettings(data.settings ?? null));
    } catch {
      showToast("Could not load payment setup.");
    } finally {
      setLoading(false);
    }
  }, [demo, showToast]);

  const loadTier = useCallback(async () => {
    if (demo) {
      // Show the Pro chooser in the demo so it is discoverable during a walkthrough.
      setSkuTier("pro");
      return;
    }
    try {
      const res = await fetch("/api/manager/subscription", { credentials: "include" });
      if (!res.ok) return;
      const data = (await res.json()) as { tier?: string | null };
      setSkuTier(normalizeManagerSkuTier(data.tier ?? null));
    } catch {
      /* leave null — the fee-payer chooser simply stays hidden */
    }
  }, [demo]);

  useEffect(() => {
    if (!open) {
      setActiveChannel(null);
      setPropertySelectionComplete(false);
      setSelectedPropertyIds(new Set());
      return;
    }
    void loadStripeStatus();
    void loadSettings();
    void loadTier();
    if (initialChannel) setActiveChannel(initialChannel);
  }, [open, initialChannel, loadStripeStatus, loadSettings, loadTier]);

  useEffect(() => {
    if (open && !propertySelectionComplete && selectedPropertyIds.size === 0 && propertyOptions.length > 0) {
      // Existing single-destination managers begin with every owned property
      // selected, preserving their live destination until they choose otherwise.
      setSelectedPropertyIds(new Set(propertyOptions.map((property) => property.id)));
    }
  }, [open, propertyOptions, propertySelectionComplete, selectedPropertyIds.size]);

  useEffect(() => {
    if (!open) return;
    const onFocus = () => void loadStripeStatus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [open, loadStripeStatus]);

  async function persistSettings(
    patch: Partial<ManagerManualPaymentSettingsView>,
    channel: PaymentChannel | null = null,
  ) {
    if (demo) {
      setDraft((prev) => draftFromSettings({ ...prev, ...patch }));
      showToast("Saved (demo).");
      return;
    }
    if (channel) setSavingChannel(channel);
    try {
      const res = await fetch("/api/portal/manager-manual-payment-settings", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...draft,
          ...patch,
          ...(channel ? { propertyIds: [...selectedPropertyIds] } : {}),
          receiptAutoMarkEnabled: patch.receiptAutoMarkEnabled ?? draft.receiptAutoMarkEnabled !== false,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        settings?: ManagerManualPaymentSettingsView;
        error?: string;
        chargesUpdated?: number;
      };
      if (!res.ok) {
        showToast(data.error ?? "Could not save payment setup.");
        return;
      }
      if (data.settings) {
        setDraft(draftFromSettings(data.settings));
        window.dispatchEvent(new CustomEvent(MANAGER_MANUAL_PAYMENT_SETTINGS_EVENT));
      }
      const chargeNote =
        typeof data.chargesUpdated === "number" && data.chargesUpdated > 0
          ? ` Updated ${data.chargesUpdated} open charge${data.chargesUpdated === 1 ? "" : "s"}.`
          : "";
      showToast(`Payment setup saved.${chargeNote}`);
    } catch {
      showToast("Could not save payment setup.");
    } finally {
      setSavingChannel(null);
    }
  }

  async function linkStripe() {
    setStripeBusy(true);
    try {
      await openStripeConnectOnboarding({ showToast });
    } finally {
      setStripeBusy(false);
    }
  }

  async function toggleAutoMark(enabled: boolean) {
    await persistSettings({ receiptAutoMarkEnabled: enabled });
  }

  async function changeFeePayer(choice: ProServiceFeeChoice) {
    if ((draft.serviceFeePayer ?? "resident") === choice) return;
    setSavingFeePayer(true);
    try {
      await persistSettings({ serviceFeePayer: choice });
    } finally {
      setSavingFeePayer(false);
    }
  }

  const zelleContactConnected = draft.zellePaymentsEnabled && draft.zelleContact.trim().length > 0;
  const venmoContactConnected = draft.venmoPaymentsEnabled && draft.venmoContact.trim().length > 0;
  const gmailLinked = Boolean(gmailStatus?.connected);
  const autoMarkOn = draft.receiptAutoMarkEnabled !== false;
  const hasForwardingInbox = Boolean(draft.paymentInboxAddress?.trim());
  const manualTrackingReady = (contactConnected: boolean) =>
    contactConnected && autoMarkOn && (gmailLinked || hasForwardingInbox);
  const zelleTrackingReady = manualTrackingReady(zelleContactConnected);
  const venmoTrackingReady = manualTrackingReady(venmoContactConnected);

  const channelModalProps = {
    draft,
    setDraft,
    paymentInboxAddress: draft.paymentInboxAddress,
    autoMarkEnabled: autoMarkOn,
    onAutoMarkChange: toggleAutoMark,
    gmailStatus,
    gmailBusy,
    gmailSyncBusy,
    onLinkGmail: linkGmail,
    onSyncGmail: () => void syncGmail(),
    showToast,
  };

  const allPropertiesSelected = propertyOptions.length > 0 && selectedPropertyIds.size === propertyOptions.length;
  const toggleAllProperties = (checked: boolean) => {
    setSelectedPropertyIds(checked ? new Set(propertyOptions.map((property) => property.id)) : new Set());
  };
  const toggleProperty = (id: string, checked: boolean) => {
    setSelectedPropertyIds((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  return (
    <>
      <Modal
        open={open && !propertySelectionComplete}
        title="Choose properties for payment setup"
        description="The Zelle destination you save next is shown only to residents and applicants for these properties."
        onClose={onClose}
        dense
        assistantStrip={false}
        panelClassName="max-w-md"
        footer={
          <ModalFooter>
            <Button
              type="button"
              variant="primary"
              className="rounded-full"
              disabled={selectedPropertyIds.size === 0 || propertyOptions.length === 0}
              data-attr="manager-payment-properties-continue"
              onClick={() => setPropertySelectionComplete(true)}
            >
              Continue
            </Button>
          </ModalFooter>
        }
      >
        <div className="space-y-3">
          <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-border bg-accent/20 px-3 py-2.5">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-border text-primary"
              checked={allPropertiesSelected}
              disabled={propertyOptions.length === 0}
              data-attr="manager-payment-all-properties"
              onChange={(event) => toggleAllProperties(event.target.checked)}
            />
            <span className="text-sm font-semibold text-foreground">All properties</span>
          </label>
          <div className="max-h-[min(40vh,16rem)] space-y-1 overflow-y-auto rounded-xl border border-border p-2">
            {propertyOptions.length === 0 ? (
              <p className="px-2 py-3 text-sm text-muted">No properties in portfolio yet.</p>
            ) : propertyOptions.map((property) => (
              <label key={property.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 hover:bg-accent/30">
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0 rounded border-border text-primary"
                  checked={selectedPropertyIds.has(property.id)}
                  data-attr={`manager-payment-property-${property.id}`}
                  onChange={(event) => toggleProperty(property.id, event.target.checked)}
                />
                <span className="min-w-0 text-sm text-foreground">{property.label}</span>
              </label>
            ))}
          </div>
        </div>
      </Modal>

      <Modal open={open && propertySelectionComplete} title="Payment setup" onClose={onClose} assistantStrip={false}>
        <div className="space-y-3">
          {loading ? <p className="text-sm text-muted">Loading…</p> : null}
          <p className="text-xs text-muted">
            Stripe deposits resident payments into your own connected Stripe account and pays out to your bank, not to
            PropLane. Each manager links their own account. Check a method to allow residents to use it; use Link to
            finish setup.
          </p>
          <HubRow
            label="Stripe (ACH)"
            connected={stripeState === "ready"}
            pending={stripeState === "incomplete"}
            pendingLabel="Finish setup"
            onLink={() => void linkStripe()}
            dataAttr="manager-payment-stripe-link"
            busy={stripeBusy}
            allowed={draft.axisPaymentsEnabled !== false}
            allowDataAttr="manager-payment-stripe-allowed"
            onAllowedChange={(allowed) => void persistSettings({ axisPaymentsEnabled: allowed })}
          />
          {stripeState === "incomplete" ? (
            <p className="text-xs text-[var(--status-pending-fg)]">
              Your Stripe account isn&apos;t ready to receive money yet. Finish onboarding (identity + bank details) so
              resident payments can be deposited.
            </p>
          ) : null}
          {stripeState === "unknown" && stripeIssue ? (
            <p className="text-xs text-[var(--status-pending-fg)]">{stripeIssue}</p>
          ) : null}
          {skuTier === "pro" ? (
            <div className="space-y-2 rounded-xl border border-border bg-card px-4 py-3.5">
              <p className="text-sm font-semibold text-foreground">Online payment service fee</p>
              <p className="text-xs text-muted">
                Choose who covers the payment processing fee on resident online payments (card, bank, Link). Your rent
                still deposits into your own Stripe account either way.
              </p>
              <div className="grid grid-cols-2 gap-2 pt-1">
                {(["resident", "manager"] as const).map((choice) => {
                  const selected = (draft.serviceFeePayer ?? "resident") === choice;
                  return (
                    <button
                      key={choice}
                      type="button"
                      disabled={savingFeePayer}
                      onClick={() => void changeFeePayer(choice)}
                      data-attr={`manager-service-fee-payer-${choice}`}
                      className={`flex flex-col rounded-xl border px-3 py-2.5 text-left transition disabled:opacity-60 ${
                        selected
                          ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                          : "border-border bg-background hover:border-primary/30"
                      }`}
                    >
                      <span className="text-sm font-semibold text-foreground">
                        {choice === "resident" ? "Resident pays" : "I'll cover it"}
                      </span>
                      <span className="mt-0.5 text-xs text-muted">
                        {choice === "resident" ? "Added at checkout" : "Deducted from your payout"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : skuTier === "business" ? (
            <p className="text-xs text-muted">
              PropLane covers the payment processing fee on resident online payments — neither you nor your residents are
              charged it.
            </p>
          ) : skuTier === "free" ? (
            <p className="text-xs text-muted">
              On the Free plan, residents cover the payment processing fee on online payments. Upgrade to Pro to choose
              who pays.
            </p>
          ) : null}
          <HubRow
            label="Zelle"
            connected={zelleTrackingReady}
            onLink={() => setActiveChannel("zelle")}
            dataAttr="manager-payment-zelle-link"
            linkLabel="Link Zelle"
            allowed={zelleContactConnected}
            allowDataAttr="manager-payment-zelle-allowed"
            onAllowedChange={(allowed) => {
              if (allowed) {
                if (!draft.zelleContact.trim()) {
                  setActiveChannel("zelle");
                  return;
                }
                void persistSettings({ zellePaymentsEnabled: true, zelleContact: draft.zelleContact.trim() }, "zelle");
                return;
              }
              void persistSettings({ zellePaymentsEnabled: false }, "zelle");
            }}
          />
          <HubRow
            label="Venmo"
            connected={venmoTrackingReady}
            onLink={() => setActiveChannel("venmo")}
            dataAttr="manager-payment-venmo-link"
            linkLabel="Link Venmo"
            allowed={venmoContactConnected}
            allowDataAttr="manager-payment-venmo-allowed"
            onAllowedChange={(allowed) => {
              if (allowed) {
                if (!draft.venmoContact.trim()) {
                  setActiveChannel("venmo");
                  return;
                }
                void persistSettings({ venmoPaymentsEnabled: true, venmoContact: draft.venmoContact.trim() }, "venmo");
                return;
              }
              void persistSettings({ venmoPaymentsEnabled: false }, "venmo");
            }}
          />
        </div>
      </Modal>

      {activeChannel ? (
        <ChannelPaymentSetupModal
          channel={activeChannel}
          open
          onClose={() => setActiveChannel(null)}
          saving={savingChannel === activeChannel}
          onSaveContact={() =>
            void persistSettings(
              activeChannel === "zelle"
                ? {
                    zelleContact: draft.zelleContact.trim(),
                    zellePaymentsEnabled: draft.zelleContact.trim().length > 0,
                  }
                : {
                    venmoContact: draft.venmoContact.trim(),
                    venmoPaymentsEnabled: draft.venmoContact.trim().length > 0,
                  },
              activeChannel,
            )
          }
          {...channelModalProps}
          gmailConnectErrorReason={gmailConnectErrorReason}
        />
      ) : null}
    </>
  );
}
