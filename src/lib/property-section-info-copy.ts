/** One-line manager help for property record sections and listing preview jumps. */
export const PROPERTY_PREVIEW_SECTION_INFO: Record<string, { title: string; body: string }> = {
  overview: {
    title: "Overview",
    body: "Photos, title, address, and the quick facts a renter sees first on the public listing.",
  },
  rooms: {
    title: "Rooms",
    body: "Every rentable room with floor, bath, availability, and price — the same list renters browse.",
  },
  "lease-basics": {
    title: "Lease basics",
    body: "Deposits, lease length, and what is included in rent on the public page.",
  },
  amenities: {
    title: "Amenities",
    body: "House-wide and in-room amenities shown on the listing, not internal ops notes.",
  },
  bundles: {
    title: "Bundles & leasing",
    body: "Optional add-ons and leasing paths a prospect can choose when they apply.",
  },
  "house-rules": {
    title: "House rules",
    body: "Policies renters must agree to; surfaced on the listing and in the lease flow.",
  },
  location: {
    title: "Location",
    body: "Neighborhood context and map placement — approximate on the public listing.",
  },
};

export const PROPERTY_RECORD_TAB_INFO: Record<string, { title: string; body: string }> = {
  preview: {
    title: "Preview",
    body: "The full public listing as renters see it, including sticky pricing and tour actions.",
  },
  "house-details": {
    title: "House details",
    body: "Rooms, baths, shared spaces, amenities, and printable house info for residents.",
  },
  "move-in": {
    title: "Move-in",
    body: "Move-in instructions, door codes, and media residents see when they arrive.",
  },
  promotion: {
    title: "Promotion",
    body: "Flyers, social posts, and listing-site syndication generated from this home.",
  },
  "ai-info": {
    title: "AI info",
    body: "Facts the leasing assistant may quote when prospects message or tour.",
  },
};
