"use client";

/**
 * "Your property manager" — the card at the top of the resident's conversation
 * list. Shown above the list so it stays visible before a thread is opened.
 *
 * Two rows per manager: the phone, then the email. Each is whichever the
 * server resolved — the provisioned work channel when it exists, otherwise the
 * manager's own profile phone / account email — so the card no longer vanishes
 * for the common manager who has not set up a work line yet.
 *
 * It renders NOTHING when the resident has no reachable manager at all (no
 * lease yet, or a manager with no phone and no email anywhere). An absent card
 * is correct; a card with nothing to act on is not.
 */
import { Mail, MessageCircle, Phone } from "lucide-react";
import {
  PORTAL_INBOX_CONTACT_CARD_GLYPH_CLASS,
  PortalInboxContactCard,
  type PortalInboxContactCardAction,
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
  contact: Pick<ResidentManagerContact, "status" | "leaseStart" | "leaseEnd">,
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

/**
 * The phone row's actions. A provisioned work number is a texting line —
 * nothing in the SMS layer ever configures a voice URL for it, so dialling it
 * would reach a dead line, which reads to a resident as their manager ignoring
 * them. The manager's own profile phone is a real line and gets Call as well.
 */
export function phoneActions(
  contact: Pick<ResidentManagerContact, "phone" | "phoneKind">,
  phoneLabel: string | null,
): PortalInboxContactCardAction[] {
  if (!contact.phone) return [];
  const who = phoneLabel ?? "your property manager";
  const call: PortalInboxContactCardAction = {
    key: "call",
    label: `Call ${who}`,
    dataAttr: "resident-manager-call-link",
    href: `tel:${contact.phone}`,
    icon: <Phone className="h-4 w-4" strokeWidth={1.9} />,
  };
  const textAction: PortalInboxContactCardAction = {
    key: "text",
    label: `Text ${who}`,
    dataAttr: "resident-manager-number-link",
    href: `sms:${contact.phone}`,
    icon: <MessageCircle className="h-4 w-4" strokeWidth={1.9} />,
  };
  return contact.phoneKind === "profile" ? [call, textAction] : [textAction];
}

function emailAction(email: string): PortalInboxContactCardAction {
  return {
    key: "email",
    label: `Email ${email}`,
    dataAttr: "resident-manager-email-link",
    href: `mailto:${email}`,
    icon: <Mail className="h-4 w-4" strokeWidth={1.9} />,
  };
}

/**
 * The number as the resident reads it. `formatSmsPhoneLabel` prints the
 * country code ("+1 (510) 309-8345"); with an avatar and two action buttons
 * beside it, that is three characters too many for the 340px list pane and the
 * number truncated mid-digit — the one thing the card is for, cut off. A
 * resident in the US does not need to be told the "+1", so a North American
 * number drops it; anything else keeps its full international form.
 */
export function residentPhoneLabel(phone: string): string {
  const label = formatSmsPhoneLabel(phone) || phone;
  return label.startsWith("+1 (") ? label.slice(3) : label;
}

const MAIL_GLYPH = (
  <span className={PORTAL_INBOX_CONTACT_CARD_GLYPH_CLASS}>
    <Mail className="h-[18px] w-[18px]" strokeWidth={1.9} />
  </span>
);

export function ResidentManagerNumberCard() {
  const contacts = useResidentManagerContacts();

  if (contacts.length === 0) return null;
  const multiple = contacts.length > 1;

  return (
    <div className="shrink-0" data-attr="resident-manager-number">
      {contacts.map((contact) => {
        const phoneLabel = contact.phone ? residentPhoneLabel(contact.phone) : null;
        const email = contact.email?.trim() || null;
        const name = contact.managerName?.trim() || null;
        const label = name ? `${name} · Your property manager` : "Your property manager";
        const note = multiple
          ? [contact.propertyLabel, managerContactCaption(contact, true)].filter(Boolean).join(" · ")
          : undefined;
        const avatar = name ? (
          <InboxAvatar name={name} className="h-9 w-9 text-[12px]" />
        ) : null;
        const key = `${contact.phone ?? ""}-${email ?? ""}-${contact.propertyLabel ?? ""}`;

        // The CONTACT leads, the same way the manager's card leads with their
        // work number. Phone first when there is one; the email takes the
        // second row so both are readable, not one hidden behind an icon.
        if (phoneLabel) {
          return (
            <PortalInboxContactCard
              key={key}
              value={phoneLabel}
              label={label}
              note={note}
              leading={
                avatar ?? (
                  <span className={PORTAL_INBOX_CONTACT_CARD_GLYPH_CLASS}>
                    <Phone className="h-[18px] w-[18px]" strokeWidth={1.9} />
                  </span>
                )
              }
              actions={phoneActions(contact, phoneLabel)}
              secondary={
                email
                  ? {
                      leading: MAIL_GLYPH,
                      value: email,
                      label: "Email",
                      actions: [emailAction(email)],
                    }
                  : undefined
              }
            />
          );
        }
        if (!email) return null;
        return (
          <PortalInboxContactCard
            key={key}
            value={email}
            label={label}
            note={note}
            leading={avatar ?? MAIL_GLYPH}
            actions={[emailAction(email)]}
          />
        );
      })}
    </div>
  );
}
