"use client";

/**
 * Manager work line + assistant email for residents — shown above the conversation
 * list so it stays visible before a thread is opened.
 */
import { useEffect, useState } from "react";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { formatSmsPhoneLabel } from "@/lib/phone-e164";

type ResidentManagerContact = {
  phone: string | null;
  assistantEmail: string | null;
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
  if (!multiple) return "Replies in PropLane show up in your conversations below.";
  if (contact.status === "upcoming") {
    const from = shortDate(contact.leaseStart);
    return from ? `From ${from}` : "Starting soon";
  }
  if (contact.status === "ended") {
    const until = shortDate(contact.leaseEnd);
    return until ? `Until ${until}` : "Previous home";
  }
  const until = shortDate(contact.leaseEnd);
  return until ? `Until ${until}` : "Replies in PropLane show up in your conversations below.";
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
        setContacts(
          Array.isArray(rows)
            ? rows.filter((row) => Boolean(row?.phone?.trim() || row?.assistantEmail?.trim()))
            : [],
        );
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
          key={`${contact.phone ?? ""}-${contact.assistantEmail ?? ""}-${contact.propertyLabel ?? ""}`}
          className="rounded-xl border border-primary/25 bg-primary/[0.05] px-3.5 py-3"
        >
          <p className="text-[11px] font-semibold uppercase tracking-wide text-primary">
            Contact your manager
            {multiple && contact.propertyLabel ? ` · ${contact.propertyLabel}` : ""}
          </p>
          {contact.phone ? (
            <a
              href={`sms:${contact.phone}`}
              className="mt-1 block font-mono text-[17px] font-semibold text-foreground"
              data-attr="resident-manager-number-link"
            >
              {formatSmsPhoneLabel(contact.phone) || contact.phone}
            </a>
          ) : null}
          {contact.assistantEmail ? (
            <a
              href={`mailto:${contact.assistantEmail}`}
              className={`block text-sm font-medium text-primary ${contact.phone ? "mt-1" : "mt-1"}`}
              data-attr="resident-manager-email-link"
            >
              {contact.assistantEmail}
            </a>
          ) : null}
          <p className="mt-1 text-xs text-muted">{managerContactCaption(contact, multiple)}</p>
        </div>
      ))}
    </div>
  );
}
