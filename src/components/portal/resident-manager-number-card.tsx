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
import { Mail, MessageCircle, Phone } from "lucide-react";
import {
  PORTAL_INBOX_CONTACT_CARD_GLYPH_CLASS,
  PortalInboxContactCard,
} from "@/components/portal/portal-inbox-contact-card";
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

export function ResidentManagerNumberCard() {
  const contacts = useResidentManagerContacts();

  if (contacts.length === 0) return null;
  const multiple = contacts.length > 1;

  return (
    <div className="shrink-0" data-attr="resident-manager-number">
      {contacts.map((contact) => {
        const phoneLabel = contact.phone
          ? formatSmsPhoneLabel(contact.phone) || contact.phone
          : null;
        const name = contact.managerName?.trim() || null;
        return (
          <PortalInboxContactCard
            key={`${contact.phone ?? ""}-${contact.assistantEmail ?? ""}-${contact.propertyLabel ?? ""}`}
            value={name ?? phoneLabel ?? contact.assistantEmail ?? "PropLane"}
            label={
              multiple && contact.propertyLabel
                ? `Your property manager · ${contact.propertyLabel}`
                : "Your property manager"
            }
            note={managerContactCaption(contact, multiple)}
            leading={
              name ? (
                <InboxAvatar name={name} className="h-9 w-9 text-[12px]" />
              ) : (
                <span className={PORTAL_INBOX_CONTACT_CARD_GLYPH_CLASS}>
                  <Phone className="h-[18px] w-[18px]" strokeWidth={1.9} />
                </span>
              )
            }
            actions={[
              /*
                Both resident actions open a TEXT, and neither is a `tel:` dial.
                This is the manager's provisioned messaging work number —
                nothing in the SMS layer ever configures a voice URL for it, so
                dialling would reach a dead line, which reads to a resident as
                their manager ignoring them. The phone glyph is the line's
                identity, not a promise that it rings.
              */
              ...(contact.phone
                ? [
                    {
                      key: "text",
                      label: `Text ${phoneLabel ?? "your property manager"}`,
                      dataAttr: "resident-manager-number-link",
                      href: `sms:${contact.phone}`,
                      icon: <MessageCircle className="h-4 w-4" strokeWidth={1.9} />,
                    },
                  ]
                : []),
              ...(contact.assistantEmail && !contact.phone
                ? [
                    {
                      key: "email",
                      label: `Email ${contact.assistantEmail}`,
                      dataAttr: "resident-manager-email-link",
                      href: `mailto:${contact.assistantEmail}`,
                      icon: <Mail className="h-4 w-4" strokeWidth={1.9} />,
                    },
                  ]
                : []),
            ]}
          />
        );
      })}
    </div>
  );
}
