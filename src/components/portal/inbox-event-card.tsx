"use client";

/**
 * An automated turn drawn as a card in the conversation timeline (A3, stay chat): glyph, bold title, one muted
 * fact line and one action link. Resident and manager threads draw it from this one component, so the two
 * views cannot drift. A turn without an `eventKind` never reaches it (`InboxBubble` keeps its plain activity row).
 *
 * No pill, no badge, no explanatory sentence: the title says what happened, the fact line is a fact.
 */
import Link from "next/link";
import { BedDouble, CalendarCheck, CircleCheck, CreditCard, FileSignature, House, KeyRound } from "lucide-react";
import {
  inboxEventAction,
  inboxEventGlyph,
  inboxEventTitleFor,
  type InboxEventCard as InboxEventCardData,
  type InboxEventGlyph,
  type InboxEventKind,
  type InboxEventViewer,
} from "@/lib/inbox-event-card";

const GLYPHS = {
  payment: CreditCard,
  lease: FileSignature,
  application: CircleCheck,
  tour: CalendarCheck,
  booking: CalendarCheck,
  key: KeyRound,
  bed: BedDouble,
} satisfies Record<InboxEventGlyph, typeof House>;

export function InboxEventCard({
  kind,
  card,
  viewer,
}: {
  kind: InboxEventKind;
  card: InboxEventCardData;
  viewer: InboxEventViewer;
}) {
  const Glyph = GLYPHS[inboxEventGlyph(kind)];
  const title = inboxEventTitleFor(viewer, kind, card.title);
  const action = inboxEventAction(viewer, kind);
  return (
    <div
      className="my-1 flex min-h-11 w-full min-w-0 items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-sm text-foreground"
      data-inbox-bubble-kind="event"
      data-inbox-event-kind={kind}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary" aria-hidden>
        <Glyph className="size-4" strokeWidth={2} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold leading-snug" data-inbox-event-title>
          {title}
        </p>
        {card.fact ? (
          <p className="truncate text-xs leading-snug text-muted" data-inbox-event-fact>
            {card.fact}
          </p>
        ) : null}
      </div>
      {action ? (
        <Link
          href={action.href}
          className="shrink-0 text-sm font-semibold text-primary hover:underline max-md:flex max-md:min-h-11 max-md:items-center"
          data-inbox-event-action={action.label}
          data-attr="inbox-event-card-action"
        >
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}
