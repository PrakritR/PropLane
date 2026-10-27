"use client";

/**
 * The stay card pinned under a one-on-one resident conversation's header (A3, stay chat): the home's photo
 * (or `NoImagePlaceholder`, never a stock photo), the street and room, one fact line (dates, rent, next
 * payment) and the three next steps for the viewer. Derived on read by `useInboxStayCard`; nothing is stored.
 * The resident and the manager draw this one component. No pills, no sentence under it.
 */
import Link from "next/link";
import { NoImagePlaceholder } from "@/components/ui/no-image-placeholder";
import { useInboxStayCard } from "@/hooks/use-inbox-stay-card";
import type { StayCard, StayCardViewer } from "@/lib/inbox-stay-card";

export function InboxStayCardView({ card }: { card: StayCard }) {
  return (
    <div
      className="flex shrink-0 items-center gap-3 border-b border-border bg-card px-3 py-2.5 md:px-[18px]"
      data-inbox-stay-card={card.source}
    >
      <div className="relative size-12 shrink-0 overflow-hidden rounded-lg bg-accent/30">
        {card.photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- a stored data URL or signed URL of the listing's own photo
          <img src={card.photoUrl} alt="" className="size-full object-cover" data-inbox-stay-photo />
        ) : (
          <NoImagePlaceholder variant="compact" label="" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold leading-snug text-foreground" data-inbox-stay-title>
          {card.title}
        </p>
        {card.fact ? (
          <p className="truncate text-xs leading-snug text-muted" data-inbox-stay-fact>
            {card.fact}
          </p>
        ) : null}
        {card.actions.length > 0 ? (
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5" data-inbox-stay-actions>
            {card.actions.map((action) => (
              <Link
                key={action.id}
                href={action.href}
                className="text-[13px] font-semibold text-primary hover:underline max-md:flex max-md:min-h-9 max-md:items-center"
                data-inbox-stay-action={action.id}
                data-attr={`inbox-stay-card-${action.id}`}
              >
                {action.label}
              </Link>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Derives and draws the card for one conversation; draws nothing when the person has no stay. */
export function InboxStayCard({
  viewer,
  enabled,
  managerUserId,
  personEmail,
  homeLabel,
}: {
  viewer: StayCardViewer;
  enabled: boolean;
  managerUserId: string | null;
  personEmail: string | null | undefined;
  homeLabel?: string | null;
}) {
  const card = useInboxStayCard({ viewer, enabled, managerUserId, personEmail, homeLabel });
  return card ? <InboxStayCardView card={card} /> : null;
}
