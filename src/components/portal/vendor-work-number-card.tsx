"use client";

/** Business contacts and sponsored send identities load independently. */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Copy, Check } from "lucide-react";
import { PortalInboxContactCard, type PortalInboxContactCardAction } from "@/components/portal/portal-inbox-contact-card";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { copyTextToClipboard } from "@/lib/manager-property-links";
import { formatSmsPhoneLabel } from "@/lib/phone-e164";
import type { VendorWorkIdentityResponse } from "@/lib/vendor-work-identity";

type Contacts = { workEmail?: string; workPhone?: string };
type Load = "loading" | "ready" | "failed";

function copyAction(text: string, copied: boolean, onCopied: () => void): PortalInboxContactCardAction {
  return { key: "copy", label: copied ? "Copied" : "Copy", dataAttr: "vendor-work-contact-copy", icon: copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />, onClick: () => void copyTextToClipboard(text).then((ok) => ok && onCopied()) };
}

function readiness(identity: VendorWorkIdentityResponse | null, channel: "email" | "sms") {
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

export function VendorWorkNumberCard() {
  const [contacts, setContacts] = useState<Contacts | null>(null);
  const [identity, setIdentity] = useState<VendorWorkIdentityResponse | null>(null);
  const [contactLoad, setContactLoad] = useState<Load>("loading");
  const [identityLoad, setIdentityLoad] = useState<Load>("loading");
  const [copied, setCopied] = useState<string | null>(null);
  const reload = () => {
    if (isDemoModeActive()) { setContacts({ workEmail: "office@northwestplumbing.test", workPhone: "+12065550142" }); setContactLoad("ready"); setIdentityLoad("ready"); return () => {}; }
    let active = true;
    void fetch("/api/vendor/business-profile", { credentials: "include", cache: "no-store" }).then(async (res) => ({ ok: res.ok, body: await res.json().catch(() => ({})) })).then(({ ok, body }) => { if (!active) return; if (!ok) setContactLoad("failed"); else { setContacts(body.profile ?? {}); setContactLoad("ready"); } }).catch(() => active && setContactLoad("failed"));
    void fetch("/api/vendor/work-identity", { credentials: "include", cache: "no-store" }).then(async (res) => ({ ok: res.ok, body: await res.json().catch(() => ({})) })).then(({ ok, body }) => { if (!active) return; if (!ok || !body.identity) setIdentityLoad("failed"); else { setIdentity(body.identity); setIdentityLoad("ready"); } }).catch(() => active && setIdentityLoad("failed"));
    return () => { active = false; };
  };
  useEffect(() => reload(), []);
  useEffect(() => { if (!copied) return; const timer = window.setTimeout(() => setCopied(null), 1600); return () => window.clearTimeout(timer); }, [copied]);
  const card = (label: "Your work number" | "Your work email", value: string | undefined, dataAttr: string) => {
    if (contactLoad === "loading") return <div className="h-[52px] animate-pulse rounded-2xl bg-muted" data-attr={`${dataAttr}-loading`} aria-label={`Loading ${label}`} />;
    if (contactLoad === "failed") return <div className="flex items-center gap-2"><PortalInboxContactCard padded={false} tone="setup" href="/vendor/profile" dataAttr={`${dataAttr}-failed`} label={label} value="Could not load" actions={[]} /><button type="button" className="text-xs font-semibold underline" onClick={() => reload()}>Retry</button></div>;
    if (!value) return <PortalInboxContactCard padded={false} tone="setup" href="/vendor/profile" dataAttr={`${dataAttr}-missing`} label={label} value="Not set" actions={[]} />;
    const shown = label === "Your work number" ? formatSmsPhoneLabel(value) || value : value;
    return <PortalInboxContactCard padded={false} dataAttr={dataAttr} label={label} value={shown} actions={[copyAction(shown, copied === dataAttr, () => setCopied(dataAttr))]} />;
  };
  const state = (channel: "email" | "sms") => identityLoad === "loading" ? "Loading" : identityLoad === "failed" ? "Failed" : readiness(identity, channel);
  const capability = (channel: "email" | "sms") => identityLoad !== "ready" ? null : identity?.[channel];
  return <div className="grid gap-2 px-3 pt-3" data-attr="vendor-work-identity">
    {card("Your work number", contacts?.workPhone, "vendor-business-work-number")}
    {card("Your work email", contacts?.workEmail, "vendor-business-work-email")}
    <div className="grid grid-cols-2 gap-2 text-xs" data-attr="vendor-sending-readiness">
      <Link href="/vendor/profile?tab=work-email" className="rounded-xl border border-border px-3 py-2">Email <span className="float-right font-semibold">{state("email")}</span><span className="block pt-1">Send {capability("email")?.sendReady ? "ready" : "unavailable"} · Receive {capability("email")?.receiveReady ? "ready" : "unavailable"}</span></Link>
      <Link href="/vendor/profile?tab=work-number" className="rounded-xl border border-border px-3 py-2">SMS <span className="float-right font-semibold">{state("sms")}</span><span className="block pt-1">Send {capability("sms")?.sendReady ? "ready" : "unavailable"} · Receive {capability("sms")?.receiveReady ? "ready" : "unavailable"}</span></Link>
    </div>
    {identityLoad === "failed" ? <button type="button" className="justify-self-start text-xs font-semibold underline" onClick={() => reload()}>Retry</button> : null}
  </div>;
}
