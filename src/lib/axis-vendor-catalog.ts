/** Curated vendors discoverable in the PropLane catalog (before added to a manager account). */
export type AxisCatalogVendor = {
  catalogId: string;
  name: string;
  trade: string;
  city: string;
  zip: string;
  phone: string;
  email: string;
  description: string;
  hourlyCents: number | null;
  serviceCents: number | null;
  notes?: string;
  /** Present only for a self-serve vendor pulled from the directory (never a curated/shared catalog row). */
  directoryVendorUserId?: string;
  /** Full multi-trade list for a directory row; `trade` stays the first one for backward-compat filtering/display. */
  trades?: string[];
  insured?: boolean;
  licensed?: boolean;
};

export const AXIS_VENDOR_CATALOG: AxisCatalogVendor[] = [
  {
    catalogId: "axis-catalog-plumbing-nw",
    name: "Northwest Plumbing Co",
    trade: "Plumbing",
    city: "Seattle, WA",
    zip: "98101",
    phone: "(206) 555-0142",
    email: "jobs@nwplumbing.example",
    description:
      "Licensed plumber for leaks, water heaters, and drain work. Typical house call billed as the service rate; extra time at the hourly rate.",
    hourlyCents: 9500,
    serviceCents: 18500,
  },
  {
    catalogId: "axis-catalog-hvac-1",
    name: "Sound HVAC Collective",
    trade: "HVAC",
    city: "Seattle, WA",
    zip: "98104",
    phone: "(206) 555-4401",
    email: "dispatch@soundhvac.example.com",
    description: "Licensed residential HVAC — installs, tune-ups, and emergency repair.",
    hourlyCents: 12500,
    serviceCents: 24500,
    notes: "Licensed residential HVAC — installs, tune-ups, and emergency repair.",
  },
  {
    catalogId: "axis-catalog-plumbing-1",
    name: "Emerald City Plumbing",
    trade: "Plumbing",
    city: "Bellevue, WA",
    zip: "98004",
    phone: "(425) 555-1182",
    email: "jobs@emeraldcityplumb.example.com",
    description: "Residential plumbing for leaks, fixtures, and water heaters across the Eastside.",
    hourlyCents: 9900,
    serviceCents: 17500,
  },
  {
    catalogId: "axis-catalog-electrical-1",
    name: "Puget Power Pros",
    trade: "Electrical",
    city: "Tacoma, WA",
    zip: "98402",
    phone: "(253) 555-9020",
    email: "service@pugetpowerpros.example.com",
    description: "Panel upgrades, outlets, and lighting for houses and small multifamily.",
    hourlyCents: 11000,
    serviceCents: 16500,
  },
  {
    catalogId: "axis-catalog-cleaning-1",
    name: "Sparkle Turnover Co.",
    trade: "Cleaning",
    city: "Seattle, WA",
    zip: "98109",
    phone: "(206) 555-7710",
    email: "turns@sparkleturnover.example.com",
    description: "Move-out and recurring unit cleaning for multifamily.",
    hourlyCents: 4500,
    serviceCents: 22000,
    notes: "Move-out and recurring unit cleaning for multifamily.",
  },
  {
    catalogId: "axis-catalog-maintenance-1",
    name: "PropLane Handyman Network",
    trade: "General maintenance",
    city: "Greater Seattle",
    zip: "98101",
    phone: "(206) 555-3300",
    email: "workorders@axishandyman.example.com",
    description: "General repairs, punch lists, and between-tenancy fixes.",
    hourlyCents: 7500,
    serviceCents: 12500,
  },
  {
    catalogId: "axis-catalog-appliance-1",
    name: "Northwest Appliance Repair",
    trade: "Appliance repair",
    city: "Kirkland, WA",
    zip: "98033",
    phone: "(425) 555-6614",
    email: "repairs@nwappliance.example.com",
    description: "In-unit appliance diagnosis and repair for common residential brands.",
    hourlyCents: 9900,
    serviceCents: 17500,
  },
  {
    catalogId: "axis-catalog-landscaping-1",
    name: "Greenline Exterior Care",
    trade: "Landscaping",
    city: "Redmond, WA",
    zip: "98052",
    phone: "(425) 555-2290",
    email: "crew@greenlinecare.example.com",
    description: "Yard, walkway, and exterior upkeep on a typical visit rate.",
    hourlyCents: 6500,
    serviceCents: 15000,
  },
  {
    catalogId: "axis-catalog-pest-1",
    name: "Harbor Pest Response",
    trade: "Pest control",
    city: "Seattle, WA",
    zip: "98122",
    phone: "(206) 555-8844",
    email: "dispatch@harborpest.example.com",
    description: "Inspection and treatment for common household pests.",
    hourlyCents: 8000,
    serviceCents: 14500,
  },
];

export function vendorCatalogEntryMatchesQuery(
  fields: {
    name: string;
    trade: string;
    city?: string;
    zip?: string;
    email?: string;
    phone?: string;
    notes?: string;
    description?: string;
  },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    fields.name,
    fields.trade,
    fields.city ?? "",
    fields.zip ?? "",
    fields.email ?? "",
    fields.phone ?? "",
    fields.notes ?? "",
    fields.description ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

export function managerOwnsCatalogVendor(
  ownVendors: { name: string; trade: string }[],
  name: string,
  trade: string,
): boolean {
  const normalizedName = name.trim().toLowerCase();
  const normalizedTrade = trade.trim();
  return ownVendors.some(
    (row) => row.name.trim().toLowerCase() === normalizedName && row.trade.trim() === normalizedTrade,
  );
}

export function searchAxisVendorCatalog(query: string): AxisCatalogVendor[] {
  return AXIS_VENDOR_CATALOG.filter((row) => vendorCatalogEntryMatchesQuery(row, query));
}

export function axisCatalogVendorById(catalogId: string | null | undefined): AxisCatalogVendor | null {
  const id = catalogId?.trim();
  if (!id) return null;
  return AXIS_VENDOR_CATALOG.find((row) => row.catalogId === id) ?? null;
}

export function formatVendorCatalogUsd(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

/** Map outgoing expense category codes to vendor trade labels. */
export function vendorTradeForExpenseCategory(categoryCode: string): string | null {
  const map: Record<string, string> = {
    plumbing: "Plumbing",
    cleaning: "Cleaning",
    maintenance: "General maintenance",
    materials: "General maintenance",
    service_fees: "General maintenance",
    utilities: "General maintenance",
    insurance: "General maintenance",
    management: "General maintenance",
    property_tax: "General maintenance",
    taxes: "General maintenance",
    mortgage: "General maintenance",
    other_expense: "General maintenance",
  };
  return map[categoryCode] ?? null;
}
