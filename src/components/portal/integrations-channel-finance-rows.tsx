"use client";

import { Building2, Copy, House, Mail } from "lucide-react";
import { useEffect, useState } from "react";

import { IntegrationRow } from "@/components/portal/integration-row";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalSettingsGroup } from "@/components/portal/portal-settings-ui";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import { gmailFilterInstructions, gmailFilterQuery } from "@/lib/channel-finance/gmail-filter";
import { FINANCE_PLATFORM_LABEL, type FinancePlatform } from "@/lib/channel-finance/types";
import { isManagerAssistantEmailStatus } from "@/lib/manager-assistant-email/manager-assistant-email-status";

const ROWS: { platform: FinancePlatform; icon: typeof House; tone: string }[] = [
  { platform: "airbnb", icon: House, tone: "text-rose-500" },
  { platform: "booking_com", icon: Building2, tone: "text-blue-600" },
];

function lastMailFact(iso: string | null | undefined): string {
  if (iso === undefined) return "";
  if (!iso) return "No mail yet";
  const d = new Date(iso);
  return `Last mail ${Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

/**
 * Settings → Integrations → Bookings: where each channel's money mail (reservations, payouts, invoices) is forwarded. One row
 * per channel: the workspace address it forwards to, the one-time Gmail filter, and when the last mail arrived.
 */
export function ChannelFinanceFeedRows() {
  const { showToast } = useAppUi();
  const workspaceId = useWorkspaces()?.active?.id ?? "";
  const [address, setAddress] = useState<string | null>(null);
  const [last, setLast] = useState<Record<string, string | null> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
    void (async () => {
      try {
        const res = await fetch(`/api/manager/assistant-email${query}`, { credentials: "include", cache: "no-store", signal: controller.signal });
        const body: unknown = res.ok ? await res.json().catch(() => null) : null;
        if (isManagerAssistantEmailStatus(body)) setAddress(body.address?.trim() || body.workspaceEmail?.address?.trim() || null);
      } catch {
        /* the address stays unknown; the row says so */
      }
      try {
        const res = await fetch("/api/portal/channel-finance", { credentials: "include", cache: "no-store", signal: controller.signal });
        if (res.ok) {
          const body = (await res.json()) as { mail?: { platform: string; lastReceivedAt: string | null }[] };
          setLast(Object.fromEntries((body.mail ?? []).map((m) => [m.platform, m.lastReceivedAt])));
        }
      } catch {
        /* no status: the fact stays blank */
      }
    })();
    return () => controller.abort();
  }, [workspaceId]);

  const copy = async (text: string, done: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(done);
    } catch {
      showToast("Could not copy.");
    }
  };

  return (
    <PortalSettingsGroup>
      {ROWS.map(({ platform, icon, tone }) => (
        <IntegrationRow
          stackOnPhone
          key={platform}
          icon={icon}
          tone={tone}
          name={`${FINANCE_PLATFORM_LABEL[platform]} payouts`}
          fact={[address ?? "Work email not set up", last ? lastMailFact(last[platform] ?? null) : ""].filter(Boolean).join(" · ")}
          factDataAttr={`settings-${platform}-finance-status`}
          dataAttr={`settings-${platform}-finance-row`}
          action={
            <>
              <PortalIconAction icon={Mail} label="Copy forwarding address" data-attr={`settings-${platform}-finance-copy-address`} disabled={!address} onClick={() => address && void copy(address, "Address copied.")} />
              <PortalIconAction icon={Copy} label="Copy Gmail filter steps" data-attr={`settings-${platform}-finance-copy-filter`} onClick={() => void copy(`${gmailFilterInstructions(platform, address ?? "")}\n\n${gmailFilterQuery(platform)}`, "Gmail filter steps copied.")} />
            </>
          }
        />
      ))}
    </PortalSettingsGroup>
  );
}
