"use client";

/**
 * The resident's OWN identity at the top of their conversation list — the
 * account every message below is sent from. It is deliberately not a manager's
 * address: a resident can talk to several managers, and each conversation row
 * names its own manager. How to reach a manager lives in that thread's header.
 */
import { useEffect, useState } from "react";
import { PortalInboxContactCard } from "@/components/portal/portal-inbox-contact-card";
import { usePortalSession } from "@/hooks/use-portal-session";

export function ResidentCommunicationIdentityCard() {
  const session = usePortalSession();
  const [profile, setProfile] = useState<{ name: string | null; email: string | null } | null>(null);
  const sessionUserId = session.userId;

  useEffect(() => {
    if (!sessionUserId) return;
    let cancelled = false;
    void fetch("/api/profile", { credentials: "include", cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { fullName?: string | null; email?: string | null } | null) => {
        if (cancelled || !body) return;
        setProfile({ name: body.fullName?.trim() || null, email: body.email?.trim() || null });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionUserId]);

  const email = profile?.email || session.email?.trim() || null;
  const name = profile?.name || null;
  const value = name || email;
  if (!value) return null;

  return (
    <div className="grid shrink-0 grid-cols-2 gap-2 px-3.5 pb-1 pt-3" data-attr="resident-communication-identity">
      <PortalInboxContactCard
        frame="box"
        value={value}
        label="You"
        secondary={name && email ? { value: email, label: "Email" } : undefined}
      />
    </div>
  );
}
