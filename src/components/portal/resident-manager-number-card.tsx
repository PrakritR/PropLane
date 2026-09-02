"use client";

/**
 * "Text your manager" — the work number a resident can reach their manager on.
 *
 * Sits ABOVE the conversation list, not inside a thread: it is the first thing
 * on the screen they opened in order to reach someone, and it stays put instead
 * of scrolling away once a conversation is open.
 *
 * Renders nothing at all when there is no sendable number. A number that cannot
 * receive a text is worse than none — the resident texts it, hears nothing, and
 * concludes their manager is ignoring them.
 */
import { useEffect, useState } from "react";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { formatSmsPhoneLabel } from "@/lib/phone-e164";

type ResidentManagerContact = {
  phone: string;
  propertyLabel: string | null;
  leaseStart: string | null;
  leaseEnd: string | null;
  status: "current" | "upcoming" | "ended";
};

function shortDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * The one line under the number. Only earned when there is something to tell
 * apart: with a single tenancy the resident does not need to be told which of
 * their one manager this is.
 */
export function managerContactCaption(
  contact: ResidentManagerContact,
  multiple: boolean,
): string {
  if (!multiple) return "Replies show up here too.";
  if (contact.status === "upcoming") {
    const from = shortDate(contact.leaseStart);
    return from ? `From ${from}` : "Starting soon";
  }
  if (contact.status === "ended") {
    const until = shortDate(contact.leaseEnd);
    return until ? `Until ${until}` : "Previous home";
  }
  const until = shortDate(contact.leaseEnd);
  return until ? `Until ${until}` : "Replies show up here too.";
}

export function ResidentManagerNumberCard() {
  const [contacts, setContacts] = useState<ResidentManagerContact[]>([]);

  useEffect(() => {
    if (isDemoModeActive()) return;
    let cancelled = false;
    void fetch("/api/resident/manager-contact", { credentials: "include", cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled || !body || typeof body !== "object") return;
        const rows = (body as { contacts?: ResidentManagerContact[] }).contacts;
        setContacts(Array.isArray(rows) ? rows.filter((row) => Boolean(row?.phone)) : []);
      })
      .catch(() => {
        // A missing number is not an error worth showing — the section is
        // simply absent, exactly as it is for a manager who has none.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (contacts.length === 0) return null;
  const multiple = contacts.length > 1;

  return (
    <div className="space-y-2 px-3 pt-3" data-attr="resident-manager-number">
      {contacts.map((contact) => (
        <div
          key={`${contact.phone}-${contact.propertyLabel ?? ""}`}
          className="rounded-xl border border-primary/25 bg-primary/[0.05] px-3.5 py-3"
        >
          <p className="text-[11px] font-semibold uppercase tracking-wide text-primary">
            Text your manager
            {multiple && contact.propertyLabel ? ` · ${contact.propertyLabel}` : ""}
          </p>
          {/* A tel: link so a phone opens its dialer/messages pre-addressed
              rather than making the resident copy digits off the screen. */}
          <a
            href={`sms:${contact.phone}`}
            className="mt-0.5 block font-mono text-[17px] font-semibold text-foreground"
            data-attr="resident-manager-number-link"
          >
            {formatSmsPhoneLabel(contact.phone) || contact.phone}
          </a>
          <p className="text-xs text-muted">{managerContactCaption(contact, multiple)}</p>
        </div>
      ))}
    </div>
  );
}
