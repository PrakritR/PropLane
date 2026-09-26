"use client";

import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle2, Mail } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppUi } from "@/components/providers/app-ui-provider";
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

type WorkspaceEmailEntry = NonNullable<ManagerAssistantEmailStatus["workspaces"]>[number];

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

/** Per-workspace status word for Channels (overall entitlement/env from the account status). */
function workspaceEmailStatusLabel(
  address: string | null,
  status: ManagerAssistantEmailStatus,
): string {
  if (!address) {
    if (status.state === "storage_unavailable") return "Setup unavailable";
    if (!status.canRequest && status.planTier === "free") return "Not available on your plan";
    return "Not set up";
  }
  if (status.canUse) return "Ready";
  if (!status.sendingAvailable || !status.receivingAvailable) return "Assigned — replies off";
  return "Assigned — paused on your plan";
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
 * Channels work-email rows (PLAN-0924-1454): one row per owned workspace,
 * address auto-minted as `{slug}@proplane.ai`. Filter matches the numbers list.
 */
export function ManagerAssistantEmailChannelRow({
  filterWorkspaceId = "all",
}: {
  /** `"all"` or a workspace id — same vocabulary as the Channels number filter. */
  filterWorkspaceId?: string;
}) {
  const { showToast } = useAppUi();
  const router = useRouter();
  const [status, setStatus] = useState<ManagerAssistantEmailStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<"request" | "refresh" | null>(null);
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [renamingWorkspaceId, setRenamingWorkspaceId] = useState<string | null>(null);
  const [localInput, setLocalInput] = useState("");
  const [addressCheck, setAddressCheck] = useState<MailboxLocalCheckResult | null>(null);
  const [checkingAddress, setCheckingAddress] = useState(false);
  const [savingAddress, setSavingAddress] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    // Drop sticky sibling addresses while the next GET (which also auto-mints) runs.
    setStatus(null);
    try {
      const res = await fetch(ENDPOINT, { credentials: "include", cache: "no-store", signal });
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
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => load(controller.signal));
    return () => controller.abort();
  }, [load]);

  const visibleEmails = useMemo(() => {
    const entries = status?.workspaces ?? [];
    if (filterWorkspaceId === "all" || !filterWorkspaceId) return entries;
    return entries.filter((e) => e.workspaceId === filterWorkspaceId);
  }, [status?.workspaces, filterWorkspaceId]);

  const renamingEntry = visibleEmails.find((e) => e.workspaceId === renamingWorkspaceId) ?? null;
  const renamingAddress = renamingEntry?.address?.trim() || "";
  const addressLocal = renamingAddress ? renamingAddress.split("@")[0] ?? "" : "";
  const addressDomain = renamingAddress ? renamingAddress.split("@")[1] ?? "" : "";

  useEffect(() => {
    if (!renamingWorkspaceId) return;
    setLocalInput(addressLocal);
    setAddressCheck(null);
  }, [renamingWorkspaceId, addressLocal]);

  useEffect(() => {
    if (!renamingWorkspaceId || !renamingAddress) return;
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
          body: JSON.stringify({
            action: "check_address",
            local: trimmed,
            workspaceId: renamingWorkspaceId,
          }),
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
  }, [localInput, addressLocal, renamingWorkspaceId, renamingAddress]);

  const canSaveAddress =
    !savingAddress &&
    addressCheck !== null &&
    addressCheck.ok &&
    addressCheck.state === "available";

  const saveAddress = useCallback(async () => {
    if (!renamingWorkspaceId) return;
    const trimmed = localInput.trim().toLowerCase();
    setSavingAddress(true);
    setError(null);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set_address",
          local: trimmed,
          workspaceId: renamingWorkspaceId,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as ManagerAssistantEmailStatus & {
        error?: string;
      };
      if (!res.ok) {
        throw new Error(body.error ?? "Could not change your work email.");
      }
      setStatus(body);
      setAddressCheck(null);
      setRenamingWorkspaceId(null);
      const next = body.workspaces?.find((w) => w.workspaceId === renamingWorkspaceId)?.address;
      if (next) {
        showToast(`Work email changed to ${next}. Mail to the old address no longer reaches you.`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change your work email.");
    } finally {
      setSavingAddress(false);
    }
  }, [localInput, renamingWorkspaceId, showToast]);

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
          body: JSON.stringify({ action: "refresh_eligibility" }),
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
    async (action: "request_address" | "refresh_eligibility", workspaceId?: string) => {
      setPendingAction(action === "refresh_eligibility" ? "refresh" : "request");
      setPendingWorkspaceId(workspaceId ?? null);
      setError(null);
      try {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            ...(workspaceId ? { workspaceId } : {}),
          }),
        });
        const body = (await res.json().catch(() => ({}))) as ManagerAssistantEmailStatus & {
          error?: string;
        };
        if (!res.ok) {
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
        } else {
          const minted = workspaceId
            ? body.workspaces?.find((w) => w.workspaceId === workspaceId)?.address
            : body.address;
          if (minted) {
            showToast(
              body.canUse
                ? "Your PropLane work email is ready."
                : "Work email assigned. Replies are off for this workspace.",
            );
          }
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not update work email settings.");
      } finally {
        setPendingAction(null);
        setPendingWorkspaceId(null);
      }
    },
    [showToast],
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
  const planMessage = assistantEmailUpsellMessage(status.planTier, status.entitlement);

  // Co-manager: read-only owner addresses for the workspaces they can see.
  if (isCoManager) {
    const shared = visibleEmails.filter((e) => !e.owned);
    if (shared.length === 0) {
      return (
        <PortalSettingsSection title="Work email">
          <PortalSettingsGroup>
            <div
              className="flex items-start gap-2 px-4 py-4 text-sm text-muted"
              data-attr="assistant-email-workspace-address-missing"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <p>
                Your workspace owner hasn&apos;t set up a work email yet. Once they do in
                Settings → Messaging, it appears here.
              </p>
            </div>
          </PortalSettingsGroup>
        </PortalSettingsSection>
      );
    }
    return (
      <>
        {shared.map((entry) => {
          const address = entry.address?.trim() || "";
          return (
            <ChannelRow
              key={entry.workspaceId}
              icon={Mail}
              channel={<>{address || "Work email"}</>}
              workspace={entry.workspaceName}
              status={address ? "Ready" : "Waiting on setup"}
              menu={
                address ? (
                  <ChannelRowMenu
                    label={`${address} actions`}
                    items={[
                      {
                        key: "copy",
                        label: "Copy address",
                        onClick: () => {
                          void copyTextToClipboard(address).then((ok) =>
                            showToast(ok ? "Work email copied." : "Could not copy address."),
                          );
                        },
                      },
                    ]}
                    dataAttr="channel-email-menu"
                  />
                ) : undefined
              }
              dataAttr="channel-row-email"
            />
          );
        })}
        {shared.some((e) => e.address) ? (
          <div className="flex items-start gap-2 border-b border-border/70 px-4 py-3 text-sm text-foreground last:border-0">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
            <p>
              Replies you send in Communication go out from the workspace owner&apos;s address
              with your name on them.
            </p>
          </div>
        ) : null}
      </>
    );
  }

  const rows: WorkspaceEmailEntry[] =
    visibleEmails.length > 0
      ? visibleEmails.filter((e) => e.owned)
      : status.workspace
        ? [
            {
              workspaceId: status.workspace.id,
              workspaceName: status.workspace.name,
              owned: status.workspace.owned,
              isDefault: status.workspace.isDefault,
              ownerName: null,
              address: status.address,
            },
          ]
        : [];

  return (
    <>
      {rows.map((entry) => {
        const address = entry.address?.trim() || "";
        const isRenaming = renamingWorkspaceId === entry.workspaceId;
        const menuItems: ChannelRowMenuItem[] = [];
        if (address) {
          menuItems.push({
            key: "copy",
            label: "Copy address",
            onClick: () => {
              void copyTextToClipboard(address).then((ok) =>
                showToast(ok ? "Work email copied." : "Could not copy address."),
              );
            },
          });
          if (status.canUse) {
            menuItems.push({
              key: "share",
              label: "Share with residents",
              onClick: () => window.dispatchEvent(new CustomEvent(WORK_CONTACT_ANNOUNCE_EVENT)),
            });
          }
          menuItems.push({
            key: "edit",
            label: "Edit",
            onClick: () => {
              setRenamingWorkspaceId(entry.workspaceId);
              setLocalInput(address.split("@")[0] ?? "");
              setAddressCheck(null);
            },
          });
        } else if (status.canRequest) {
          menuItems.push({
            key: "setup",
            label:
              pendingAction === "request" && pendingWorkspaceId === entry.workspaceId
                ? "Setting up…"
                : "Setup",
            disabled: pendingAction !== null,
            onClick: () => void postAction("request_address", entry.workspaceId),
          });
        }
        if (planMessage && !unverifiedEntitlement && !address) {
          menuItems.push({
            key: "view-plan",
            label: "View plans",
            onClick: () => router.push("/portal/profile?tab=billing"),
          });
        } else if (
          !address &&
          !status.canRequest &&
          !status.entitlement.eligible &&
          !unverifiedEntitlement
        ) {
          menuItems.push({
            key: "refresh-eligibility",
            label: pendingAction === "refresh" ? "Checking…" : "Refresh eligibility",
            disabled: pendingAction !== null,
            onClick: () => void postAction("refresh_eligibility", entry.workspaceId),
          });
        }

        const channel = isRenaming ? (
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
                setRenamingWorkspaceId(null);
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
          <>{address || "Work email"}</>
        );

        return (
          <ChannelRow
            key={entry.workspaceId}
            icon={Mail}
            channel={channel}
            channelWrap={isRenaming}
            workspace={entry.workspaceName}
            status={
              isRenaming
                ? addressAvailabilityLabel(addressCheck, checkingAddress)
                : workspaceEmailStatusLabel(address || null, status)
            }
            menu={
              isRenaming ? undefined : (
                <ChannelRowMenu
                  label={`${address || entry.workspaceName} work email actions`}
                  items={menuItems}
                  dataAttr="channel-email-menu"
                />
              )
            }
            dataAttr="channel-row-email"
          />
        );
      })}
      {error ? (
        <div className="border-b border-border/70 px-4 py-2 text-xs font-medium text-danger last:border-0" role="alert">
          {error}
        </div>
      ) : null}
    </>
  );
}
