"use client";

/**
 * Vendor Settings > Work number & email (Oct 6). Any vendor with a verified
 * phone claims a PropLane work number (area code -> pick one of three -> claim);
 * managers then text that number, it forwards to the vendor's verified phone,
 * and the vendor's replies go back to the manager they last talked to.
 * Free while NUMBER_SUBSCRIPTION_ENABLED is off: PropLane keeps the service fee on payouts instead. With it on,
 * the number is the $5/month PropLane Number: Subscribe, then Manage and Buy credit (vendor-number-billing.tsx).
 *
 * Labels and controls only - nothing is explained under a row (AGENTS.md § No subtext).
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CopyIconAction } from "@/components/portal/portal-icon-action";
import {
  PortalSettingsGroup,
  PortalSettingsRow,
  PortalSettingsSection,
  PortalSettingsSections,
  PortalSettingsToggle,
} from "@/components/portal/portal-settings-ui";
import { identityStatusLabel } from "@/components/portal/vendor-business-settings";
import { useOptionalAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ListSkeleton } from "@/components/ui/list-skeleton";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { copyTextToClipboard } from "@/lib/manager-property-links";
import { formatSmsPhoneLabel } from "@/lib/phone-e164";
import { VENDOR_PAY_FEE_BPS } from "@/lib/platform-fees";
import type { VendorWorkIdentityResponse } from "@/lib/vendor-work-identity";
import { PHONE_VERIFIED_EVENT, VENDOR_NUMBER_CAP_NOTICE, VENDOR_NUMBER_FAIR_USE_SEGMENTS_PER_MONTH } from "@/lib/vendor-work-number";
import {
  useVendorNumberBilling,
  vendorNumberEntitledStatus,
  VendorNumberSubscribeRow,
  VendorNumberSubscribedRows,
} from "@/components/portal/vendor-number-billing";

type Candidate = { phoneNumber: string; claimToken: string };

const DEMO_IDENTITY: VendorWorkIdentityResponse = {
  sponsoredBy: "proplane",
  email: { state: "ready", value: "dima@vendors.proplane.ai", sendReady: true, receiveReady: true, canSetup: false, blockedReason: "none" },
  sms: { state: "ready", value: "+14255550177", sendReady: true, receiveReady: true, canSetup: false, blockedReason: "none" },
  inboundAvailable: { email: true, sms: true },
  smsUiEnabled: true,
  usage: { outboundUsed: 42, outboundCap: VENDOR_NUMBER_FAIR_USE_SEGMENTS_PER_MONTH, capState: "available", smsSegmentsUsed: 42 },
  eligibility: { phoneVerified: true, verifiedPhoneLabel: "(206) 555-0142" },
  forwardToPhone: true,
};

const SMS_SETTLING = new Set(["provisioning", "reconciling"]);

/** The vendor's work identity. Demo mode renders a sample and never touches the network. */
function useWorkIdentity(demo: boolean) {
  const [identity, setIdentity] = useState<VendorWorkIdentityResponse | null>(null);
  const [load, setLoad] = useState<"loading" | "ready" | "failed">("loading");
  const reload = useCallback(async () => {
    if (demo) return;
    setLoad("loading");
    try {
      const res = await fetch("/api/vendor/work-identity", { credentials: "include", cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.identity) throw new Error("unavailable");
      setIdentity(body.identity as VendorWorkIdentityResponse);
      setLoad("ready");
    } catch {
      setLoad("failed");
    }
  }, [demo]);
  useEffect(() => {
    void reload();
  }, [reload]);
  // Verifying the phone on this same page (vendor onboarding) opens the claim without a reload.
  useEffect(() => {
    if (demo) return;
    const onVerified = () => void reload();
    window.addEventListener(PHONE_VERIFIED_EVENT, onVerified);
    return () => window.removeEventListener(PHONE_VERIFIED_EVENT, onVerified);
  }, [demo, reload]);
  return { identity, setIdentity, load, reload };
}

function ClaimNumber({ identity, reload }: { identity: VendorWorkIdentityResponse; reload: () => void }) {
  const [areaCode, setAreaCode] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<"search" | "claim" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState(false);

  async function search() {
    const digits = areaCode.replace(/\D/g, "").slice(0, 3);
    if (!/^[2-9]\d{2}$/.test(digits)) {
      setError("Enter a valid 3-digit area code.");
      return;
    }
    setBusy("search");
    setError(null);
    try {
      const res = await fetch("/api/vendor/work-identity/candidates", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ areaCode: digits }),
      });
      const body = (await res.json().catch(() => ({}))) as { candidates?: Candidate[]; error?: string; dryRun?: boolean };
      if (!res.ok || !body.candidates?.length) {
        setCandidates([]);
        setSelected(null);
        setError(body.error ?? "No numbers are available in that area code. Try another.");
        return;
      }
      setCandidates(body.candidates);
      setSelected(body.candidates[0]?.phoneNumber ?? null);
      setDryRun(Boolean(body.dryRun));
    } catch {
      setError("Could not search numbers right now.");
    } finally {
      setBusy(null);
    }
  }

  async function claim() {
    const pick = candidates.find((candidate) => candidate.phoneNumber === selected);
    if (!pick) return;
    setBusy("claim");
    setError(null);
    try {
      const res = await fetch("/api/vendor/work-identity", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "sms", idempotencyKey: crypto.randomUUID(), phoneNumber: pick.phoneNumber, claimToken: pick.claimToken }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; identity?: VendorWorkIdentityResponse };
      if (!res.ok) {
        setError(body.error ?? "Could not claim that number. Try again.");
        return;
      }
      reload();
    } catch {
      setError("Could not claim that number. Try again.");
    } finally {
      setBusy(null);
    }
  }

  if (!identity.sms.canSetup) {
    return (
      <PortalSettingsRow label="Work number">
        <span className="text-sm text-muted" data-attr="vendor-work-number-unavailable">
          {identityStatusLabel(identity.sms)}
        </span>
      </PortalSettingsRow>
    );
  }
  return (
    <div className="border-b border-border" data-attr="vendor-work-number-claim">
      <PortalSettingsRow label="Area code" className="border-b-0">
        <div className="flex items-center justify-end gap-2">
          <Input
            aria-label="Area code"
            inputMode="numeric"
            maxLength={3}
            className="w-20 text-center"
            placeholder="425"
            value={areaCode}
            onChange={(event) => setAreaCode(event.target.value.replace(/\D/g, "").slice(0, 3))}
            onKeyDown={(event) => {
              if (event.key === "Enter") void search();
            }}
            data-attr="vendor-work-number-area-code"
          />
          <Button variant="secondary" disabled={busy !== null} onClick={() => void search()} data-attr="vendor-work-number-search">
            {busy === "search" ? "Searching…" : "Find numbers"}
          </Button>
        </div>
      </PortalSettingsRow>
      {candidates.length > 0 ? (
        <div role="radiogroup" aria-label="Choose a number" className="px-4 pb-3" data-attr="vendor-work-number-candidates">
          {candidates.map((candidate) => (
            <label key={candidate.phoneNumber} className="flex min-h-11 cursor-pointer items-center gap-3 py-1 text-[15px]">
              <input
                type="radio"
                name="vendor-work-number-candidate"
                className="size-4"
                checked={selected === candidate.phoneNumber}
                onChange={() => setSelected(candidate.phoneNumber)}
              />
              <span className="font-medium text-foreground">{formatSmsPhoneLabel(candidate.phoneNumber) ?? candidate.phoneNumber}</span>
            </label>
          ))}
          <div className="flex items-center justify-between gap-3 pt-2">
            {dryRun ? (
              <span className="text-xs font-medium text-muted" data-attr="vendor-work-number-dry-run">
                Dry run · no real number is bought
              </span>
            ) : (
              <span />
            )}
            <Button variant="primary" disabled={busy !== null || !selected} onClick={() => void claim()} data-attr="vendor-work-number-claim">
              {busy === "claim" ? "Claiming…" : "Claim number"}
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="px-4 pb-3 text-[12.5px] text-danger" data-attr="vendor-work-number-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function WorkEmailRow({ identity, reload }: { identity: VendorWorkIdentityResponse; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useOptionalAppUi();
  const value = identity.email.value;
  async function claim() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/vendor/work-identity", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "email", idempotencyKey: crypto.randomUUID() }),
      });
      if (!res.ok) throw new Error("unavailable");
      reload();
    } catch {
      setError("Could not claim a work email. Try again.");
    } finally {
      setBusy(false);
    }
  }
  if (value) {
    return (
      <PortalSettingsRow label="Work email">
        <span className="inline-flex items-center gap-1">
          <b className="break-all text-[14.5px] font-bold text-foreground" data-attr="vendor-work-email-value">
            {value}
          </b>
          <CopyIconAction
            label="Copy work email"
            onCopy={() => copyTextToClipboard(value).then((ok) => ok && toast?.showToast("Work email copied."))}
            data-attr="vendor-work-email-copy"
          />
        </span>
      </PortalSettingsRow>
    );
  }
  return (
    <PortalSettingsRow label="Work email">
      {identity.email.canSetup ? (
        <span className="inline-flex flex-col items-end gap-1">
          <Button variant="secondary" disabled={busy} onClick={() => void claim()} data-attr="vendor-work-email-claim">
            {busy ? "Claiming…" : "Claim work email"}
          </Button>
          {error ? <span className="text-[12.5px] text-danger">{error}</span> : null}
        </span>
      ) : (
        <span className="text-sm text-muted">{identityStatusLabel(identity.email)}</span>
      )}
    </PortalSettingsRow>
  );
}

export function VendorWorkNumberSettings() {
  const demo = isDemoModeActive();
  const live = useWorkIdentity(demo);
  const numberBilling = useVendorNumberBilling(demo);
  const toast = useOptionalAppUi();
  const [forwardOverride, setForwardOverride] = useState<boolean | null>(null);
  const [forwardError, setForwardError] = useState<string | null>(null);
  const identity = demo ? DEMO_IDENTITY : live.identity;
  const load = demo ? "ready" : live.load === "ready" && !numberBilling.loaded ? "loading" : live.load;
  const reload = live.reload;

  useEffect(() => {
    setForwardOverride(null);
  }, [live.identity?.forwardToPhone]);

  const setForwarding = useCallback(
    async (next: boolean) => {
      setForwardError(null);
      setForwardOverride(next);
      if (demo) return;
      try {
        const res = await fetch("/api/vendor/work-identity", {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ forwardToPhone: next }),
        });
        const body = (await res.json().catch(() => ({}))) as { identity?: VendorWorkIdentityResponse; error?: string };
        if (!res.ok || !body.identity) throw new Error(body.error ?? "failed");
        live.setIdentity(body.identity);
        toast?.showToast(next ? "Texts will forward to your phone." : "Forwarding is off.");
      } catch {
        setForwardOverride(null);
        setForwardError("Forwarding could not be saved. Try again.");
      }
    },
    [demo, live, toast],
  );

  if (load === "loading") {
    return (
      <PortalSettingsSections>
        <PortalSettingsSection title="Work number & email">
          <div className="rounded-xl border border-border bg-card px-4 py-4" role="status" aria-label="Loading work number">
            <ListSkeleton rows={3} showLeading={false} />
          </div>
        </PortalSettingsSection>
      </PortalSettingsSections>
    );
  }
  if (load === "failed" || !identity) {
    return (
      <PortalSettingsSections>
        <PortalSettingsSection title="Work number & email">
          <PortalSettingsGroup>
            <p className="px-4 py-4 text-sm text-danger" role="alert">
              Could not load{" "}
              <button type="button" className="font-semibold underline" onClick={() => void reload()}>
                Retry
              </button>
            </p>
          </PortalSettingsGroup>
        </PortalSettingsSection>
      </PortalSettingsSections>
    );
  }

  const number = identity.sms.value;
  const numberReady = Boolean(number) && identity.sms.state === "ready";
  const settling = SMS_SETTLING.has(identity.sms.state);
  const phoneVerified = identity.eligibility?.phoneVerified !== false;
  const forwarding = forwardOverride ?? identity.forwardToPhone ?? true;
  const cap = identity.usage.outboundCap > 0 ? identity.usage.outboundCap : VENDOR_NUMBER_FAIR_USE_SEGMENTS_PER_MONTH;
  const capReached = identity.usage.capState === "exhausted";
  // PropLane Number (flag on): `billing` is null while it is off, which leaves every row below exactly as it was.
  const billing = numberBilling.billing;
  const entitled = billing ? vendorNumberEntitledStatus(billing.subscription?.status) : true;
  const needsSubscription = Boolean(billing) && !entitled;

  return (
    <PortalSettingsSections>
      <PortalSettingsSection title="Work number & email">
        <PortalSettingsGroup>
          {numberReady ? (
            <PortalSettingsRow label="Work number">
              <span className="inline-flex items-center gap-1">
                <b className="text-[14.5px] font-bold text-foreground" data-attr="vendor-work-number-value">
                  {formatSmsPhoneLabel(number) ?? number}
                </b>
                <CopyIconAction
                  label="Copy work number"
                  onCopy={() => copyTextToClipboard(number ?? "").then((ok) => ok && toast?.showToast("Work number copied."))}
                  data-attr="vendor-work-number-copy"
                />
                {needsSubscription ? (
                  <span className="text-sm text-muted" data-attr="vendor-work-number-paused">
                    Paused
                  </span>
                ) : null}
              </span>
            </PortalSettingsRow>
          ) : settling ? (
            <PortalSettingsRow label="Work number">
              <span className="text-sm text-muted" data-attr="vendor-work-number-pending">
                Setting up…
              </span>
            </PortalSettingsRow>
          ) : !phoneVerified ? (
            <PortalSettingsRow label="Work number">
              <Link
                href="/vendor/settings?tab=messaging"
                className="text-sm font-semibold text-primary underline-offset-2 hover:underline"
                data-attr="vendor-work-number-verify-phone"
              >
                Verify your phone to get one
              </Link>
            </PortalSettingsRow>
          ) : needsSubscription && billing ? (
            <VendorNumberSubscribeRow billing={billing} demo={demo} />
          ) : (
            <ClaimNumber identity={identity} reload={() => void reload()} />
          )}
          {numberReady && needsSubscription && billing ? <VendorNumberSubscribeRow billing={billing} demo={demo} /> : null}
          <WorkEmailRow identity={identity} reload={() => void reload()} />
          {billing && entitled ? <VendorNumberSubscribedRows billing={billing} demo={demo} onChanged={() => void numberBilling.reload()} /> : null}
          {numberReady ? (
            <>
              <PortalSettingsRow label="Forward texts to my phone">
                <span className="inline-flex items-center gap-2">
                  {identity.eligibility?.verifiedPhoneLabel ? (
                    <span className="text-sm text-muted" data-attr="vendor-work-number-forward-phone">
                      {identity.eligibility.verifiedPhoneLabel}
                    </span>
                  ) : null}
                  <PortalSettingsToggle
                    checked={forwarding}
                    onChange={(next) => void setForwarding(next)}
                    label="Forward texts to my phone"
                    dataAttr="vendor-work-number-forward-toggle"
                  />
                </span>
              </PortalSettingsRow>
              <PortalSettingsRow label="Texts this month">
                <span className="text-sm font-medium text-foreground" data-attr="vendor-work-number-usage">
                  {identity.usage.smsSegmentsUsed.toLocaleString("en-US")} of {cap.toLocaleString("en-US")}
                </span>
              </PortalSettingsRow>
            </>
          ) : null}
          <PortalSettingsRow label="Service fee">
            <span className="text-sm font-medium text-foreground" data-attr="vendor-work-number-service-fee">
              {VENDOR_PAY_FEE_BPS / 100}% of payouts through PropLane
            </span>
          </PortalSettingsRow>
        </PortalSettingsGroup>
        {forwardError ? (
          <p role="alert" className="px-1 text-[12.5px] text-danger" data-attr="vendor-work-number-forward-error">
            {forwardError}
          </p>
        ) : null}
        {capReached ? (
          <p role="status" className="rounded-lg border px-4 py-3 text-sm portal-banner-pending" data-attr="vendor-work-number-cap-notice">
            {VENDOR_NUMBER_CAP_NOTICE}
          </p>
        ) : null}
      </PortalSettingsSection>
    </PortalSettingsSections>
  );
}
