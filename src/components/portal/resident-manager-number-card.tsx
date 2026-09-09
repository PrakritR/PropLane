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
import { Mail, MessageCircle } from "lucide-react";
import { PortalInboxNumberStrip } from "@/components/portal/portal-inbox-number-strip";
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
        const value = name ?? phoneLabel ?? contact.assistantEmail ?? "PropLane";
        return (
          <PortalInboxNumberStrip
            key={`${contact.phone ?? ""}-${contact.assistantEmail ?? ""}-${contact.propertyLabel ?? ""}`}
            label={multiple && contact.propertyLabel ? contact.propertyLabel : "Manager"}
            value={value}
            caption={managerContactCaption(contact, multiple)}
            leading={name ? <InboxAvatar name={name} className="h-6 w-6 text-[10px]" /> : undefined}
            actions={[
              /*
                Both resident actions open a TEXT, and neither is a `tel:` dial.
                This is the manager's provisioned messaging work number —
                nothing in the SMS layer ever configures a voice URL for it, so
                dialling would reach a dead line, which reads to a resident as
                their manager ignoring them.
              */
              ...(contact.phone
                ? [
                    {
                      key: "text",
                      label: `Text ${phoneLabel ?? "your property manager"}`,
                      dataAttr: "resident-manager-number-link",
                      href: `sms:${contact.phone}`,
                      icon: <MessageCircle className="h-[15px] w-[15px]" strokeWidth={1.9} />,
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
                      icon: <Mail className="h-[15px] w-[15px]" strokeWidth={1.9} />,
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
