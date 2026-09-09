"use client";

/**
 * "Your property manager" — the card at the top of the resident's conversation
 * list. Shown above the list so it stays visible before a thread is opened.
 *
 * It renders NOTHING when the resident has no reachable manager, which is a
 * real and common state (no lease yet, or a manager with no work number and no
 * assistant address). An absent card is correct; a card with nothing to act on
 * is not.
 */
import { MessageCircle, Phone } from "lucide-react";
import { InboxAvatar } from "@/components/portal/portal-inbox-ui";
import {
  useResidentManagerContacts,
  type ResidentManagerContact,
} from "@/hooks/use-resident-manager-contacts";
import { formatSmsPhoneLabel } from "@/lib/phone-e164";

function shortDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * The one line under the identity. Only earned when there is something to tell
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

const HERO_ACTION_CLASS =
  "flex h-[42px] min-w-0 flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-primary/35 bg-card px-2.5 text-[13px] font-semibold text-primary transition-colors hover:bg-primary/[0.06]";

export function ResidentManagerNumberCard() {
  const contacts = useResidentManagerContacts();

  if (contacts.length === 0) return null;
  const multiple = contacts.length > 1;

  return (
    <div className="shrink-0 space-y-3 px-3.5 pb-4 pt-3.5" data-attr="resident-manager-number">
      {contacts.map((contact) => {
        const phoneLabel = contact.phone
          ? formatSmsPhoneLabel(contact.phone) || contact.phone
          : null;
        const name = contact.managerName?.trim() || null;
        return (
          <div
            key={`${contact.phone ?? ""}-${contact.assistantEmail ?? ""}-${contact.propertyLabel ?? ""}`}
            className="rounded-2xl border border-primary/25 bg-primary/[0.05] px-4 pb-4 pt-3.5"
          >
            <p className="text-[12.5px] font-bold tracking-[-0.01em] text-primary">
              Your property manager
              {multiple && contact.propertyLabel ? ` · ${contact.propertyLabel}` : ""}
            </p>

            <div className="mt-3 flex items-center gap-3">
              {name ? <InboxAvatar name={name} className="h-[52px] w-[52px] text-[16px]" /> : null}
              <div className="min-w-0">
                {name ? (
                  <p className="truncate text-[19px] font-extrabold tracking-[-0.025em] text-foreground">
                    {name}
                  </p>
                ) : phoneLabel ? (
                  <p className="truncate font-mono text-[19px] font-bold tracking-[-0.01em] text-foreground">
                    {phoneLabel}
                  </p>
                ) : null}
                <p className="mt-0.5 truncate text-[13px] text-muted">
                  {name ? "Property Manager · PropLane" : "PropLane"}
                </p>
                <p className="mt-1.5 flex items-center gap-2 text-xs text-muted">
                  <span
                    className="h-[7px] w-[7px] shrink-0 rounded-full bg-[var(--status-confirmed-fg)]"
                    aria-hidden
                  />
                  {managerContactCaption(contact, multiple)}
                </p>
              </div>
            </div>

            {contact.phone || contact.assistantEmail ? (
              <div className="mt-4 flex gap-3">
                {contact.phone ? (
                  <>
                    {/*
                      Both buttons open a TEXT, and neither is a `tel:` dial.
                      This is the manager's provisioned messaging work number —
                      nothing in the SMS layer ever configures a voice URL for
                      it, so dialling would reach a dead line, which reads to a
                      resident as their manager ignoring them. The phone icon is
                      the line's identity, not a promise that it rings.
                    */}
                    <a
                      href={`sms:${contact.phone}`}
                      className={HERO_ACTION_CLASS}
                      data-attr="resident-manager-number-link"
                    >
                      <Phone className="h-4 w-4 shrink-0" strokeWidth={1.9} />
                      <span className="truncate">{phoneLabel}</span>
                    </a>
                    <a
                      href={`sms:${contact.phone}`}
                      className={HERO_ACTION_CLASS}
                      data-attr="resident-manager-text-link"
                      aria-label={`Text ${phoneLabel ?? "your property manager"}`}
                    >
                      <MessageCircle className="h-4 w-4 shrink-0" strokeWidth={1.9} />
                      <span className="truncate">Text us</span>
                    </a>
                  </>
                ) : null}
                {contact.assistantEmail && !contact.phone ? (
                  <a
                    href={`mailto:${contact.assistantEmail}`}
                    className={HERO_ACTION_CLASS}
                    data-attr="resident-manager-email-link"
                  >
                    <span className="truncate">{contact.assistantEmail}</span>
                  </a>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
