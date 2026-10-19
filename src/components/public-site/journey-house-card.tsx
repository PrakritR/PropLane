"use client";

import Image from "next/image";
import { useMemo } from "react";
import type { MockProperty } from "@/data/types";
import { NoImagePlaceholder } from "@/components/ui/no-image-placeholder";
import { buildPropertyBrowseCards } from "@/lib/room-listings-catalog";
import "./journey-forms.css";

/** The house a journey page is about: lead photo (or the honest empty tile), title, area, price. */
export function JourneyHouseCard({ property }: { property: MockProperty }) {
  const card = useMemo(() => buildPropertyBrowseCards([property])[0], [property]);
  const photo = card?.imageUrl ?? "";
  const area = property.neighborhood || property.address;
  const price = card?.priceLabel || property.rentLabel;
  return (
    <div className="ps-j-house" data-attr="journey-house-card">
      <div className="ps-j-house-photo">
        {photo ? (
          <Image
            src={photo}
            alt=""
            fill
            className="object-cover"
            sizes="(max-width: 899px) 100vw, 280px"
            unoptimized={photo.startsWith("data:")}
          />
        ) : (
          <NoImagePlaceholder variant="compact" />
        )}
      </div>
      <div className="ps-j-house-body">
        <p className="ps-j-house-title">{property.title}</p>
        {area ? <p className="ps-j-house-area">{area}</p> : null}
        {price ? <p className="ps-j-house-price">{price}</p> : null}
      </div>
    </div>
  );
}
