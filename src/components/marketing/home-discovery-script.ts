/**
 * The homepage's one sample conversation (captain feedback #13): a prospect finds a house by texting the
 * PropLane number. The hero phone, the Software demo's first chapter and the manager inbox it shows all read
 * these lines, so the three can never disagree. Sample data from the demo's Seattle world (product-mock
 * fixtures: Willow Court, Maple Duplex, Fremont Studio); no photo is invented — the cards draw the
 * no-photo tile.
 */

export type DiscoveryListing = {
  id: string;
  title: string;
  street: string;
  neighborhood: string;
  rentLabel: string;
  availableLabel: string;
};

export const DISCOVERY_LISTINGS: readonly DiscoveryListing[] = [
  { id: "prop-willow", title: "Willow Court", street: "61 Willow Court", neighborhood: "Wallingford", rentLabel: "$1,080/mo", availableLabel: "Available now" },
  { id: "prop-fremont", title: "Fremont Studio", street: "3301 Fremont Ave N", neighborhood: "Fremont", rentLabel: "$1,400/mo", availableLabel: "Available now" },
  { id: "prop-maple", title: "Maple Duplex", street: "1412 Maple Ct", neighborhood: "Ballard", rentLabel: "$1,850/mo", availableLabel: "Available Nov 1" },
];

export const DISCOVERY_TOUR = {
  listingId: "prop-willow",
  street: "61 Willow Court",
  dayLabel: "Thursday",
  timeLabel: "5:30 PM",
} as const;

export type DiscoveryLine =
  | { kind: "prospect"; text: string }
  | { kind: "proplane"; text: string }
  | { kind: "listings"; listings: readonly DiscoveryListing[] }
  | { kind: "tour"; street: string; dayLabel: string; timeLabel: string }
  | { kind: "divider"; text: string };

/** In order. The divider marks the next day, before the reminder. */
export const DISCOVERY_LINES: readonly DiscoveryLine[] = [
  { kind: "prospect", text: "Hey, are there any houses available in the Seattle area for rent?" },
  { kind: "proplane", text: "Yes. Three open now:" },
  { kind: "listings", listings: DISCOVERY_LISTINGS },
  { kind: "proplane", text: "Want to see one?" },
  { kind: "prospect", text: "The Wallingford one — can I see it Thursday?" },
  { kind: "tour", street: DISCOVERY_TOUR.street, dayLabel: DISCOVERY_TOUR.dayLabel, timeLabel: DISCOVERY_TOUR.timeLabel },
  { kind: "divider", text: "Wednesday" },
  {
    kind: "proplane",
    text: `Your tour at ${DISCOVERY_TOUR.street} is tomorrow at ${DISCOVERY_TOUR.timeLabel}. Reply C to reschedule.`,
  },
];

/** The same thread as plain text, the way the manager inbox stores an SMS conversation (cards arrive as links). */
export function discoveryLineAsText(line: DiscoveryLine): string | null {
  switch (line.kind) {
    case "prospect":
    case "proplane":
      return line.text;
    case "listings":
      return line.listings.map((l) => `${l.title}, ${l.neighborhood} · ${l.rentLabel} · ${l.availableLabel}`).join("\n");
    case "tour":
      return `Tour booked: ${line.street}, ${line.dayLabel} at ${line.timeLabel}.`;
    default:
      return null;
  }
}
