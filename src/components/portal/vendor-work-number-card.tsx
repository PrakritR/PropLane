"use client";

/**
 * The vendor's work EMAIL card. The vendor's PropLane text number (claimed with a
 * verified phone, Oct 6) lives in Settings > Work number & email; this card is the
 * email only. Business contacts and the sponsored email identity load independently.
 */
import { useEffect, useState } from "react";
import { Copy, Check, RefreshCw } from "lucide-react";
import { PortalInboxContactCard, type PortalInboxContactCardAction } from "@/components/portal/portal-inbox-contact-card";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { copyTextToClipboard } from "@/lib/manager-property-links";
import type { VendorWorkIdentityResponse } from "@/lib/vendor-work-identity";

type Contacts = { workEmail?: string };
type Load = "loading" | "ready" | "failed";

function copyAction(text: string, copied: boolean, onCopied: () => void): PortalInboxContactCardAction {
  return { key: "copy", label: copied ? "Copied" : "Copy", dataAttr: "vendor-work-contact-copy", icon: copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />, onClick: () => void copyTextToClipboard(text).then((ok) => ok && onCopied()) };
}

function readiness(identity: VendorWorkIdentityResponse | null, channel: "email") {
  const value = identity?.[channel];
  if (!value) return "Unavailable";
  if (value.blockedReason === "provider_disabled") return "Disabled";
  if (value.blockedReason === "provider_unconfigured") return "Unavailable";
  if (value.blockedReason === "platform_capacity_reached") return "Capacity reached";
  if (value.state === "provisioning" || value.state === "reconciling") return "Pending";
  if (value.state === "blocked" || value.state === "quarantined") return "Failed";
  if (value.state === "disabled" || value.state === "released") return "Disabled";
  if (value.sendReady && value.receiveReady) return "Ready";
  if (value.state === "ready") return value.sendReady ? "Send ready" : value.receiveReady ? "Receive ready" : "Failed";
  return "Set up";
}

/**
 * Folded onto the identity card's own label line instead of the separate
 * "Email · Disabled" / "SMS · Disabled" status cards this replaced (captain,
 * 2026-09-27) — same independent send/receive capability per channel, one
 * line instead of a second card.
 */
function channelCaption(
  load: Load,
  identity: VendorWorkIdentityResponse | null,
  channel: "email",
): { text: string; warn: boolean } {
  if (load === "loading") return { text: "Checking status…", warn: false };
  if (load === "failed") return { text: "Status unavailable", warn: true };
  const capability = identity?.[channel];
  const state = readiness(identity, channel);
  const sendReady = Boolean(capability?.sendReady);
  const receiveReady = Boolean(capability?.receiveReady);
  return {
    text: `${state} · Send ${sendReady ? "ready" : "unavailable"} · Receive ${receiveReady ? "ready" : "unavailable"}`,
    warn: !(sendReady && receiveReady),
  };
}

export function VendorWorkNumberCard() {
  const [contacts, setContacts] = useState<Contacts | null>(null);
  const [identity, setIdentity] = useState<VendorWorkIdentityResponse | null>(null);
  const [contactLoad, setContactLoad] = useState<Load>("loading");
  const [identityLoad, setIdentityLoad] = useState<Load>("loading");
  const [copied, setCopied] = useState<string | null>(null);
  const reload = () => {
    if (isDemoModeActive()) { setContacts({ workEmail: "office@northwestplumbing.test" }); setContactLoad("ready"); setIdentityLoad("ready"); return () => {}; }
    let active = true;
    void fetch("/api/vendor/business-profile", { credentials: "include", cache: "no-store" }).then(async (res) => ({ ok: res.ok, body: await res.json().catch(() => ({})) })).then(({ ok, body }) => { if (!active) return; if (!ok) setContactLoad("failed"); else { setContacts(body.profile ?? {}); setContactLoad("ready"); } }).catch(() => active && setContactLoad("failed"));
    void fetch("/api/vendor/work-identity", { credentials: "include", cache: "no-store" }).then(async (res) => ({ ok: res.ok, body: await res.json().catch(() => ({})) })).then(({ ok, body }) => { if (!active) return; if (!ok || !body.identity) setIdentityLoad("failed"); else { setIdentity(body.identity); setIdentityLoad("ready"); } }).catch(() => active && setIdentityLoad("failed"));
    return () => { active = false; };
  };
  useEffect(() => reload(), []);
  useEffect(() => { if (!copied) return; const timer = window.setTimeout(() => setCopied(null), 1600); return () => window.clearTimeout(timer); }, [copied]);
  const card = (
    label: "Your work email",
    value: string | undefined,
    dataAttr: string,
    channel: "email",
  ) => {
    if (contactLoad === "loading") return <div className="h-[52px] animate-pulse rounded-2xl bg-muted" data-attr={`${dataAttr}-loading`} aria-label={`Loading ${label}`} />;
    if (contactLoad === "failed") return <div className="flex items-center gap-2"><PortalInboxContactCard padded={false} tone="setup" href="/vendor/profile" dataAttr={`${dataAttr}-failed`} label={label} value="Could not load" actions={[]} /><button type="button" className="text-xs font-semibold underline" onClick={() => reload()}>Retry</button></div>;
    if (!value) return <PortalInboxContactCard padded={false} tone="setup" href="/vendor/profile" dataAttr={`${dataAttr}-missing`} label={label} value="Set up work email" actions={[]} />;
    const shown = value;
    const caption = channelCaption(identityLoad, identity, channel);
    const actions: PortalInboxContactCardAction[] = [copyAction(shown, copied === dataAttr, () => setCopied(dataAttr))];
    if (identityLoad === "failed") {
      actions.push({
        key: "retry",
        label: "Retry email status",
        dataAttr: `${dataAttr}-status-retry`,
        icon: <RefreshCw className="h-4 w-4" />,
        onClick: () => reload(),
      });
    }
    return (
      <PortalInboxContactCard
        padded={false}
        dataAttr={dataAttr}
        label={label}
        value={shown}
        note={caption.text}
        noteTone={caption.warn ? "warn" : "muted"}
        actions={actions}
      />
    );
  };
  return (
    <div className="grid gap-2 px-3 pt-3" data-attr="vendor-work-identity">
      {card("Your work email", contacts?.workEmail, "vendor-business-work-email", "email")}
    </div>
  );
}
