"use client";

import { useEffect, useState } from "react";
import { Mail, MessageSquare } from "lucide-react";

import { IntegrationRow } from "@/components/portal/integration-row";
import { PortalSettingsGroup } from "@/components/portal/portal-settings-ui";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import { Button } from "@/components/ui/button";
import { isManagerAssistantEmailStatus } from "@/lib/manager-assistant-email/manager-assistant-email-status";

type Channel = { value: string | null; loaded: boolean };

/** `+12065550001` → `(206) 555-0001`; anything else is shown as stored. */
export function formatWorkNumber(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return national.length === 10 ? `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}` : raw;
}

/**
 * Settings → Integrations → Messages: the workspace's work number and work
 * email as connection rows. They are read here and edited in one place only -
 * Communication settings owns setup, sharing and announcements - so Manage
 * hands over to it rather than growing a second editing surface.
 */
export function ManagerMessageChannelsPanel({ onManage }: { onManage?: () => void }) {
  const workspaceId = useWorkspaces()?.active?.id ?? "";
  const [number, setNumber] = useState<Channel>({ value: null, loaded: false });
  const [email, setEmail] = useState<Channel>({ value: null, loaded: false });

  useEffect(() => {
    const controller = new AbortController();
    const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
    const read = async (url: string): Promise<unknown> => {
      try {
        const res = await fetch(url, { credentials: "include", cache: "no-store", signal: controller.signal });
        return res.ok ? await res.json().catch(() => null) : null;
      } catch {
        return null;
      }
    };
    void (async () => {
      const [numberBody, emailBody] = await Promise.all([
        read(`/api/manager/messaging-number${query}`),
        read(`/api/manager/assistant-email${query}`),
      ]);
      if (controller.signal.aborted) return;
      const phone = (numberBody as { number?: { phoneNumber?: unknown } } | null)?.number?.phoneNumber;
      setNumber({ value: typeof phone === "string" && phone.trim() ? phone.trim() : null, loaded: true });
      const address = isManagerAssistantEmailStatus(emailBody) && emailBody.canUse ? emailBody.address?.trim() || null : null;
      setEmail({ value: address, loaded: true });
    })();
    return () => controller.abort();
  }, [workspaceId]);

  const manage = (which: "number" | "email") => (
    <Button variant="ghost" data-attr={`settings-messages-${which}-manage`} onClick={onManage}>
      Manage
    </Button>
  );
  const fact = (channel: Channel, format: (v: string) => string) =>
    !channel.loaded ? "" : channel.value ? format(channel.value) : "Not set up";

  return (
    <PortalSettingsGroup>
      <IntegrationRow
        icon={MessageSquare}
        tone="text-emerald-600"
        name="Work number"
        fact={fact(number, formatWorkNumber)}
        factDataAttr="settings-messages-number"
        dataAttr="settings-messages-number-row"
        action={manage("number")}
      />
      <IntegrationRow
        icon={Mail}
        tone="text-blue-600"
        name="Work email"
        fact={fact(email, (v) => v)}
        factDataAttr="settings-messages-email"
        dataAttr="settings-messages-email-row"
        action={manage("email")}
      />
    </PortalSettingsGroup>
  );
}
