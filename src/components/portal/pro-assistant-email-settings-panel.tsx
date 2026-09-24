"use client";

import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle2, Mail } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import { useSettingsPropertyScope } from "@/components/portal/settings-property-scope";
import {
  PortalSettingsField,
  PortalSettingsGroup,
  PortalSettingsSection,
} from "@/components/portal/portal-settings-ui";
import { ChannelRow, ChannelRowMenu, type ChannelRowMenuItem } from "@/components/portal/portal-channel-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { copyTextToClipboard } from "@/lib/manager-property-links";
import {
  assistantEmailEntitlementIsUnverified,
  assistantEmailUpsellMessage,
} from "@/lib/manager-assistant-email/assistant-email-eligibility-copy";
import type { ManagerAssistantEmailStatus } from "@/lib/manager-assistant-email/manager-assistant-email-status";
import type { MailboxLocalCheckResult } from "@/lib/manager-assistant-email/manager-assistant-email.server";
import { WORK_CONTACT_ANNOUNCE_EVENT } from "@/lib/work-contact-announce";

const ENDPOINT = "/api/manager/assistant-email";
const ADDRESS_CHECK_DEBOUNCE_MS = 400;

/** The Availability row's value, in the same vocabulary `checkWorkspaceAssistantMailboxLocal` uses. */
function addressAvailabilityLabel(
  check: MailboxLocalCheckResult | null,
  checking: boolean,
): string {
  if (checking) return "Checking…";
  if (!check) return "Current address";
  if (check.ok) return check.state === "current" ? "Current address" : "Available";
  if (check.state === "reserved") return "Reserved";
  if (check.state === "taken") return "Taken";
  return check.message;
}

/** The Status row — the email's answer to the work number's "Status". */
export function workEmailStatusLabel(status: ManagerAssistantEmailStatus): string {
  switch (status.state) {
    case "ready":
      return "Ready";
    case "assigned_send_off":
      return "Assigned — replies off";
    case "assigned_plan_hold":
      return "Assigned — paused on your plan";
    case "requestable":
      return "Not set up";
    case "storage_unavailable":
      return "Setup unavailable";
    case "unavailable":
      return status.planTier === "free" ? "Not available on your plan" : "Not set up";
  }
}

/**
 * The "Who can write in" row.
 *
 * This is the email's analogue of the number's "Carrier registration": the one
 * fact a manager cannot guess from the address itself. Three different people
 * may write to it and each reaches a different assistant, and until now nothing
 * in the product said so anywhere.
 */
export function workEmailAudienceLabel(status: ManagerAssistantEmailStatus): string {
  if (status.state === "ready") return "Your team, your residents, and prospects";
  if (status.state === "assigned_send_off") return "Nobody until replies are switched on";
  if (status.state === "assigned_plan_hold") return "Nobody until your plan is active again";
  return "Nobody yet";
}

/**
 * The Channels row for the work email (PLAN-0920-1530). One row, one ⋯ menu
 * (Copy address · Share with residents · Rename) — the old standalone "Work
 * email" card, its Availability/Status/Who-can-write-in fields, and the
 * bottom read-only copy box are gone; every fact it carried now lives either
 * on this row or in Settings → Communication → Automation (`workEmailAudienceLabel`,
 * read by `CommunicationSettingsPanel`).
 */
export function ManagerAssistantEmailChannelRow() {
  const { showToast } = useAppUi();
  const router = useRouter();
  const workspaces = useWorkspaces();
  const scope = useSettingsPropertyScope();
  const workspaceName = scope.workspaceId
    ? workspaces?.workspaces.find((workspace) => workspace.id === scope.workspaceId)?.name
    : undefined;
  const emailUrl = scope.workspaceId
    ? `${ENDPOINT}?workspaceId=${encodeURIComponent(scope.workspaceId)}`
    : ENDPOINT;
  const workspaceBody = useMemo(
    () => (scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
    [scope.workspaceId],
  );
  const [status, setStatus] = useState<ManagerAssistantEmailStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<"request" | "refresh" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The custom-local-part editor (owner branch only). `addressLocal`/`addressDomain`
  // are the current SAVED address, split for the input + fixed suffix.
  const addressLocal = status?.address ? status.address.split("@")[0] ?? "" : "";
  const addressDomain = status?.address ? status.address.split("@")[1] ?? "" : "";
  const [localInput, setLocalInput] = useState("");
  const [addressCheck, setAddressCheck] = useState<MailboxLocalCheckResult | null>(null);
  const [checkingAddress, setCheckingAddress] = useState(false);
  const [savingAddress, setSavingAddress] = useState(false);
  /** Rename is opened from the row's ⋯ menu rather than always being live. */
  const [renaming, setRenaming] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(emailUrl, { credentials: "include", cache: "no-store", signal });
      const body = (await res.json().catch(() => ({}))) as ManagerAssistantEmailStatus & {
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? "Could not load work email settings.");
      setStatus(body);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "Could not load work email settings.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [emailUrl]);

  // The address belongs to the settings-bar workspace; read again on a pick.
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => load(controller.signal));
    return () => controller.abort();
  }, [load]);

  const copyAddress = useCallback(async () => {
    const address = status?.address;
    if (!address) return;
    const ok = await copyTextToClipboard(address);
    showToast(ok ? "Work email copied." : "Could not copy address.");
  }, [showToast, status?.address]);

  // The saved local part is the source of truth; resync the editable input
  // whenever it changes (initial load, workspace switch, a completed save).
  useEffect(() => {
    setLocalInput(addressLocal);
    setAddressCheck(null);
  }, [addressLocal]);

  // Debounced availability check as the manager types a new local part.
  useEffect(() => {
    if (!status?.address) return;
    const trimmed = localInput.trim().toLowerCase();
    if (!trimmed || trimmed === addressLocal) {
      setAddressCheck(null);
      setCheckingAddress(false);
      return;
    }
    setCheckingAddress(true);
    const controller = new AbortController();
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "check_address", local: trimmed, ...workspaceBody }),
          signal: controller.signal,
        });
        const body = (await res.json().catch(() => null)) as MailboxLocalCheckResult | null;
        if (body) setAddressCheck(body);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setAddressCheck({ ok: false, state: "invalid", message: "Could not check that address." });
      } finally {
        if (!controller.signal.aborted) setCheckingAddress(false);
      }
    }, ADDRESS_CHECK_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [localInput, addressLocal, status?.address, workspaceBody]);

  const canSaveAddress =
    !savingAddress &&
    addressCheck !== null &&
    addressCheck.ok &&
    addressCheck.state === "available";

  const saveAddress = useCallback(async () => {
    const trimmed = localInput.trim().toLowerCase();
    setSavingAddress(true);
    setError(null);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_address", local: trimmed, ...workspaceBody }),
      });
      const body = (await res.json().catch(() => ({}))) as ManagerAssistantEmailStatus & {
        error?: string;
      };
      if (!res.ok) {
        throw new Error(body.error ?? "Could not change your work email.");
      }
      setStatus(body);
      setAddressCheck(null);
      if (body.address) {
        setRenaming(false);
        showToast(
          `Work email changed to ${body.address}. Mail to the old address no longer reaches you.`,
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change your work email.");
    } finally {
      setSavingAddress(false);
    }
  }, [localInput, showToast, workspaceBody]);

  /**
   * Settle an unverified plan by itself, instead of behind a button. Reading
   * the billing source needs no human judgement, and the account that saw
   * "Check eligibility" was a new one with no stored entitlement row — the
   * least likely to know what the button was for.
   *
   * It cannot become a billing ping: the server gates on the ABSENCE of that
   * row, throttles the endpoint to three calls a minute, and writes a row on
   * every resolved outcome; the ref holds this to a single attempt per mount.
   * Later plan changes arrive through the Stripe and RevenueCat webhooks,
   * which reconcile the same entitlement.
   */
  const settleAttemptedRef = useRef(false);
  const entitlementUnverified = status
    ? assistantEmailEntitlementIsUnverified(status.entitlement)
    : false;
  useEffect(() => {
    if (!entitlementUnverified || settleAttemptedRef.current) return;
    settleAttemptedRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "refresh_eligibility", ...workspaceBody }),
        });
        if (!res.ok) return;
        const body = (await res.json().catch(() => ({}))) as ManagerAssistantEmailStatus;
        if (!cancelled && body && typeof body === "object" && "entitlement" in body) {
          setStatus(body);
        }
      } catch {
        // Work the manager never asked for should not raise an error banner.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entitlementUnverified]);

  const postAction = useCallback(
    async (action: "request_address" | "refresh_eligibility") => {
      setPendingAction(action === "refresh_eligibility" ? "refresh" : "request");
      setError(null);
      try {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ...workspaceBody }),
        });
        const body = (await res.json().catch(() => ({}))) as ManagerAssistantEmailStatus & {
          error?: string;
        };
        if (!res.ok) {
          // A refusal still carries the updated status (e.g. an address that
          // already existed). Apply it so the button reflects what the server
          // will actually accept next.
          if (body && typeof body === "object" && "entitlement" in body) setStatus(body);
          throw new Error(
            body.error ??
              (action === "refresh_eligibility"
                ? "Could not refresh work email eligibility."
                : "Could not set up your work email."),
          );
        }
        setStatus(body);
        if (action === "refresh_eligibility") {
          showToast("Work email eligibility refreshed.");
        } else if (body.address) {
          showToast(
            body.canUse
              ? "Your PropLane work email is ready."
              : "Work email assigned. Replies are off for this workspace.",
          );
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not update work email settings.");
      } finally {
        setPendingAction(null);
      }
    },
    [showToast, workspaceBody],
  );

  if (loading && !status) {
    return (
      <div className="border-b border-border/70 px-4 py-3 text-[13px] text-muted last:border-0" data-attr="assistant-email-loading">
        Loading work email…
      </div>
    );
  }

  if (error && !status) {
    return (
      <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3 last:border-0">
        <span className="text-[13px] text-muted">{error}</span>
        <Button type="button" variant="ghost" className="min-h-9 px-3 text-xs" onClick={() => load()} data-attr="assistant-email-retry">
          Try again
        </Button>
      </div>
    );
  }

  if (!status) return null;

  const isCoManager = status.workspaceRole === "co_manager";
  const unverifiedEntitlement = assistantEmailEntitlementIsUnverified(status.entitlement);

  // One work email per workspace. A co-manager reads the owner's address here —
  // nothing to request, no plan upsell. A legacy address of their own
  // (requested before addresses were workspace-owned) is named so they know it
  // is being retired, but it is never the address this panel leads with.
  // Mirrors the work number card's co-manager branch line for line.
  if (isCoManager) {
    const workspace = status.workspaceEmail ?? null;
    const workspaceAddress = workspace?.address?.trim() || "";
    const owner = workspace?.ownerName?.trim() || "your workspace owner";
    const legacyOwnAddress =
      status.address && status.address !== workspaceAddress ? status.address : "";
    return (
      <PortalSettingsSection
        title="Work email"
      >
        <PortalSettingsGroup>
          <PortalSettingsField
            label="Workspace email"
            value={workspaceAddress || "Not set up yet"}
            action={
              workspaceAddress ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-10 px-3 text-xs"
                  onClick={async () => {
                    const ok = await copyTextToClipboard(workspaceAddress);
                    showToast(ok ? "Work email copied." : "Could not copy address.");
                  }}
                  data-attr="assistant-email-copy"
                >
                  Copy
                </Button>
              ) : undefined
            }
          />
          <PortalSettingsField label="Status" value={workspaceAddress ? "Ready" : "Waiting on setup"} />
          <PortalSettingsField label="Managed by" value={owner} />
          <div className="space-y-4 px-4 py-4">
            {workspaceAddress ? (
              <div className="flex items-start gap-2 text-sm text-foreground">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                <p>
                  Ready. Replies you send in Communication go out from this address with your name
                  on them, and you can email it from your PropLane profile email to talk to PropLane
                  Assistant about the houses assigned to you.
                </p>
              </div>
            ) : (
              <div
                className="flex items-start gap-2 text-sm text-muted"
                data-attr="assistant-email-workspace-address-missing"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <p>
                  {owner} hasn&apos;t set up a work email for this workspace. Once they do in
                  Settings → Messaging, it appears here — there is nothing for you to request.
                </p>
              </div>
            )}
            {legacyOwnAddress ? (
              <p className="text-xs text-muted" data-attr="assistant-email-legacy-own-address">
                {legacyOwnAddress} was set up for you before addresses became shared per workspace.
                Mail to it now reaches this workspace&apos;s inbox, and it will be retired.
              </p>
            ) : null}
          </div>
        </PortalSettingsGroup>
      </PortalSettingsSection>
    );
  }

  const planMessage = assistantEmailUpsellMessage(status.planTier, status.entitlement);

  // One ⋯ menu covers every action the old card spread across four buttons
  // (Copy, Save, Request, View plans, Refresh eligibility, Refresh status,
  // Tell residents). Only the actions this exact state can actually take are
  // offered — never a disabled item with no explanation, since a row has no
  // room for one.
  const menuItems: ChannelRowMenuItem[] = [];
  if (status.address) {
    menuItems.push({ key: "copy", label: "Copy address", onClick: () => void copyAddress() });
    if (status.canUse) {
      menuItems.push({
        key: "share",
        label: "Share with residents",
        onClick: () => window.dispatchEvent(new CustomEvent(WORK_CONTACT_ANNOUNCE_EVENT)),
      });
    }
    menuItems.push({
      key: "rename",
      label: "Rename",
      onClick: () => {
        setLocalInput(addressLocal);
        setAddressCheck(null);
        setRenaming(true);
      },
    });
  } else if (status.canRequest) {
    menuItems.push({
      key: "request",
      label: pendingAction === "request" ? "Requesting…" : "Request work email",
      disabled: pendingAction !== null,
      onClick: () => void postAction("request_address"),
    });
  }
  if (planMessage && !unverifiedEntitlement) {
    menuItems.push({
      key: "view-plan",
      label: "View plans",
      onClick: () => router.push("/portal/profile?tab=billing"),
    });
  } else if (!status.address && !status.canRequest && !status.entitlement.eligible && !unverifiedEntitlement) {
    menuItems.push({
      key: "refresh-eligibility",
      label: pendingAction === "refresh" ? "Checking…" : "Refresh eligibility",
      disabled: pendingAction !== null,
      onClick: () => void postAction("refresh_eligibility"),
    });
  }
  if (
    status.state === "assigned_send_off" ||
    status.state === "assigned_plan_hold" ||
    status.state === "storage_unavailable"
  ) {
    menuItems.push({
      key: "refresh-status",
      label: loading ? "Checking…" : "Refresh status",
      disabled: loading,
      onClick: () => void load(),
    });
  }

  const channel = renaming ? (
    <span className="contents" data-attr="assistant-email-rename-row">
      <Input
        aria-label="Work email address"
        data-attr="assistant-email-local"
        value={localInput}
        onChange={(event) => setLocalInput(event.target.value.toLowerCase())}
        disabled={savingAddress}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        maxLength={32}
        className="w-36 min-w-[7rem] shrink-0 py-1.5 text-[13px] font-semibold"
      />
      <span className="shrink-0 text-[13.5px] font-semibold text-muted">@{addressDomain}</span>
      <Button
        type="button"
        variant="ghost"
        className="min-h-9 shrink-0 px-2.5 text-xs"
        disabled={savingAddress}
        onClick={() => {
          setRenaming(false);
          setLocalInput(addressLocal);
          setAddressCheck(null);
        }}
        data-attr="assistant-email-rename-cancel"
      >
        Cancel
      </Button>
      <Button
        type="button"
        className="min-h-9 shrink-0 px-2.5 text-xs"
        disabled={!canSaveAddress}
        loading={savingAddress}
        onClick={() => saveAddress()}
        data-attr="assistant-email-save"
      >
        Save
      </Button>
    </span>
  ) : (
    <>{status.address ?? "Work email"}</>
  );

  return (
    <>
      <ChannelRow
        icon={Mail}
        channel={channel}
        channelWrap={renaming}
        workspace={workspaceName ?? "This workspace"}
        status={renaming ? addressAvailabilityLabel(addressCheck, checkingAddress) : workEmailStatusLabel(status)}
        menu={renaming ? undefined : <ChannelRowMenu label="Work email actions" items={menuItems} dataAttr="channel-email-menu" />}
        dataAttr="channel-row-email"
      />
      {error ? (
        <div className="border-b border-border/70 px-4 py-2 text-xs font-medium text-danger last:border-0" role="alert">
          {error}
        </div>
      ) : null}
    </>
  );
}
