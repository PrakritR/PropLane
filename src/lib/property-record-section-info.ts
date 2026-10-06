/**
 * One- or two-sentence help for each property record rail section (studio
 * replica `property-sections-0930.js` INFO map).
 */
export const PROPERTY_RECORD_SECTION_INFO: Readonly<
  Record<string, { title: string; body: string }>
> = {
  preview: {
    title: "Preview",
    body: "What renters see on the public listing page — one scroll with every section visible.",
  },
  "house-details": {
    title: "House details",
    body: "Getting in, Wi-Fi, trash days, house rules and contacts. Residents read this after they move in.",
  },
  "move-in": {
    title: "Move-in",
    body: "Move-in instructions and photos for the whole house and for each room, sent when a lease starts.",
  },
  application: {
    title: "Applications",
    body: "Application forms renters fill out for this property. Preview or edit a form and add new ones.",
  },
  lease: {
    title: "Lease",
    body: "Leases you can send for this property. Open one to preview it, add or upload a lease.",
  },
  forms: {
    title: "Forms",
    body: "Forms residents fill out after they sign: add one, edit its questions, and choose which stay it applies to.",
  },
  pricing: {
    title: "Pricing",
    body: "What residents pay: each room, bundles, and the whole house — rent, deposit, fees and utilities.",
  },
  requests: {
    title: "Services",
    body: "Extra services residents can request at this property and what each one costs.",
  },
  promotion: {
    title: "Promotion",
    body: "Promote this property to more renters — flyers, posts, printables and listing feeds.",
  },
  "ai-info": {
    title: "AI info",
    body: "What the PropLane assistant knows when it answers renters about tours, rules, pricing and the area.",
  },
  activity: {
    title: "Activity",
    body: "A timeline of everything that happened at this property, newest first.",
  },
};

export const PROPERTY_PREVIEW_JUMP_SECTION_INFO: Readonly<
  Record<string, { title: string; body: string }>
> = {
  overview: {
    title: "Overview",
    body: "The top of the public listing: photos, price and a short summary of the home.",
  },
  rooms: {
    title: "Rooms",
    body: "Every room a renter can pick, with its rent and whether it is available.",
  },
  lease: {
    title: "Lease",
    body: "Lease types this property offers, plus rent, deposit and fees as renters see them.",
  },
  amenities: {
    title: "Amenities",
    body: "What comes with the home, like laundry or fast Wi-Fi.",
  },
  bundles: {
    title: "Bundles",
    body: "Packages for renting two or more rooms together.",
  },
  rules: {
    title: "Rules",
    body: "House rules renters agree to, like quiet hours and guests.",
  },
  location: {
    title: "Location",
    body: "Where the home is and what is nearby.",
  },
};
