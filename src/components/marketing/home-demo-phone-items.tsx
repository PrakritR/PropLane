import type { ReactNode } from "react";
import { HOME_DEMO_PHOTOS } from "@/components/demo/home-demo-script";
import { DISCOVERY_LISTINGS } from "./home-discovery-script";
import type { HomePhoneItem } from "./home-iphone-phone";
import type { HomeDemoPhoneItem } from "@/lib/demo/home-demo-embed";

/** The three open homes as the prospect's phone draws them (no photo: the no-photo tile, never a stock image). */
function ListingCards({ ids }: { ids: readonly string[] }): ReactNode {
  const listings = DISCOVERY_LISTINGS.filter((listing) => ids.includes(listing.id));
  return (
    <ul className="home-demo-listings" aria-label="Open homes">
      {listings.map((listing) => (
        <li key={listing.id} className="home-demo-listing">
          <span className="home-demo-listing-tile" aria-hidden="true" />
          <span className="home-demo-listing-text">
            <strong>{listing.title}</strong>
            <span>{listing.street} · {listing.neighborhood}</span>
            <span>{listing.rentLabel} · {listing.availableLabel}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** What the embed says the phone shows, as `HomeIphonePhone` items. */
export function homeDemoPhoneItems(items: readonly HomeDemoPhoneItem[]): HomePhoneItem[] {
  return items.map((item): HomePhoneItem => {
    switch (item.kind) {
      case "in":
      case "out":
        return { kind: item.kind, text: item.text };
      case "divider":
        return { kind: "time", text: item.text };
      case "tour":
        return { kind: "card", icon: "calendar", eyebrow: "TOUR BOOKED", title: item.street, sub: `${item.dayLabel}, ${item.timeLabel}` };
      case "listings":
        return { kind: "node", node: <ListingCards ids={item.ids} /> };
      case "photo":
        return {
          kind: "node",
          node: (
            <span className={`home-demo-photo home-demo-photo--${item.from}`}>
              {/* A drawn sample illustration (an inline SVG data URL), never a stock or listing photo. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={HOME_DEMO_PHOTOS[item.art]} alt={item.art === "leak" ? "Photo of a leaking faucet" : "Photo of the repaired faucet"} width={400} height={300} />
            </span>
          ),
        };
    }
  });
}
