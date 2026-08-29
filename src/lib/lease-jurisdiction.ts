import disclosureClauseRules from "../../leases/disclosure-clause-rules.json";
import {
  LEASE_JURISDICTION_TEMPLATE_REGISTRY,
  type LeaseJurisdictionTemplateConfig,
  type LeaseJurisdictionRegistryEntry,
} from "@/lib/lease-templates/types";

export type LeaseJurisdiction =
  | "seattle"
  | "san_francisco"
  | "california"
  | "washington"
  | "unsupported";

/** State is a two-letter USPS abbreviation; city is a normalized registry key when present. */
export type JurisdictionKey = { state: string; city?: string };

type LeaseAddress = {
  address?: string;
  city?: string;
  state?: string;
  neighborhood?: string;
  zip?: string;
  postalCode?: string;
};

export type LeaseJurisdictionInput = {
  listingProperty?: LeaseAddress & { neighborhood?: string } | null;
  leasedRoom?: LeaseAddress & { neighborhood?: string } | null;
  submission?: LeaseAddress & { neighborhood?: string } | null;
  application?: { currentCity?: string; currentState?: string } | null;
};

const SEATTLE_RE = /\bseattle\b/i;
const SEATTLE_STREET_RE = /\b(?:\d+\s+)?[\w\s]{0,40}\bave\s+ne\b/i;
const SF_RE = /\b(san\s*francisco|sf,\s*ca|,\s*sf\b)\b/i;

function propertyHaystack(ctx: LeaseJurisdictionInput): string {
  return [
    ctx.submission?.address,
    ctx.submission?.city,
    ctx.submission?.state,
    ctx.submission?.zip,
    ctx.submission?.postalCode,
    ctx.listingProperty?.address,
    ctx.listingProperty?.city,
    ctx.listingProperty?.state,
    ctx.listingProperty?.neighborhood,
    ctx.listingProperty?.zip,
    ctx.listingProperty?.postalCode,
    ctx.submission?.neighborhood,
    ctx.leasedRoom?.address,
    ctx.leasedRoom?.city,
    ctx.leasedRoom?.state,
    ctx.leasedRoom?.neighborhood,
    ctx.leasedRoom?.zip,
    ctx.leasedRoom?.postalCode,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function haystackFromContext(ctx: LeaseJurisdictionInput): string {
  const property = propertyHaystack(ctx);
  const applicant = [ctx.application?.currentCity, ctx.application?.currentState].filter(Boolean).join(" ").toLowerCase();
  return [property, applicant].filter(Boolean).join(" ");
}

function normalizedState(value: string | undefined): string | null {
  const state = value?.trim().toUpperCase();
  if (state === "CA" || state === "CALIFORNIA") return "CA";
  if (state === "WA" || state === "WASHINGTON") return "WA";
  return null;
}

function normalizedCity(value: string | undefined): string | null {
  const city = value?.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (city === "san francisco" || city === "sf") return "san_francisco";
  if (city === "seattle") return "seattle";
  return null;
}

function jurisdictionKey(state: string | null, city: string | null): JurisdictionKey | null {
  if (!state) return null;
  const stateEntry = LEASE_JURISDICTION_TEMPLATE_REGISTRY[state];
  if (!stateEntry) return null;
  if (city && stateEntry.cities?.[city]) return { state, city };
  return { state };
}

function addressHaystack(address: LeaseAddress | null | undefined): string {
  return [address?.address, address?.city, address?.state, address?.neighborhood, address?.zip, address?.postalCode]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function structuredPropertyJurisdiction(ctx: LeaseJurisdictionInput): JurisdictionKey | null {
  const addresses: Array<LeaseAddress | null | undefined> = [ctx.listingProperty, ctx.leasedRoom, ctx.submission];
  for (const address of addresses) {
    const state = normalizedState(address?.state);
    const city = normalizedCity(address?.city);
    if (!state) continue;
    // A populated structured city is authoritative even when it has no local overlay. A
    // Fremont record, for example, must not inherit a stale "San Francisco" address string.
    if (address?.city?.trim()) return jurisdictionKey(state, city);
    // Some future record shapes may provide state separately but leave city joined into the
    // street address. In that case, retain the city-level match when it corroborates the state.
    const joined = resolveFromHaystack(addressHaystack(address));
    if (joined?.state === state && joined.city) return joined;
    return jurisdictionKey(state, null);
  }
  return null;
}

function stateSignalFromHaystack(hay: string): string | null {
  const hasWashington = /\b(wa|washington)\b/i.test(hay);
  const hasCalifornia = /\b(ca|california)\b/i.test(hay);
  if (hasWashington === hasCalifornia) return null;
  return hasWashington ? "WA" : "CA";
}

/** USPS abbreviations and full names, so only a real state token can veto. */
const US_STATE_TOKENS = new Set(
  [
    "AL","AK","AZ","AR","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
    "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI",
    "SC","SD","TN","TX","UT","VT","VA","WV","WI","WY","DC",
    "ALABAMA","ALASKA","ARIZONA","ARKANSAS","COLORADO","CONNECTICUT","DELAWARE","FLORIDA","GEORGIA",
    "HAWAII","IDAHO","ILLINOIS","INDIANA","IOWA","KANSAS","KENTUCKY","LOUISIANA","MAINE","MARYLAND",
    "MASSACHUSETTS","MICHIGAN","MINNESOTA","MISSISSIPPI","MISSOURI","MONTANA","NEBRASKA","NEVADA",
    "NEW HAMPSHIRE","NEW JERSEY","NEW MEXICO","NEW YORK","NORTH CAROLINA","NORTH DAKOTA","OHIO",
    "OKLAHOMA","OREGON","PENNSYLVANIA","RHODE ISLAND","SOUTH CAROLINA","SOUTH DAKOTA","TENNESSEE",
    "TEXAS","UTAH","VERMONT","VIRGINIA","WEST VIRGINIA","WISCONSIN","WYOMING",
  ],
);

/**
 * An explicit out-of-scope STATE, read from the structured field when the record has one.
 * String heuristics cannot do this job: a bare /\bor\b/ vetoed "Unit A or B" and any Seattle
 * address on SW Oregon St, while narrowing it to a comma or ZIP position missed a record whose
 * state lives in its own field with no comma anywhere in the joined text.
 */
function explicitOutOfScopeState(ctx: LeaseJurisdictionInput): boolean {
  // PROPERTY fields only. Reading application.currentState here was catastrophic: no property
  // shape carries a `state` field in production, while the wizard REQUIRES the applicant's
  // current state, so the applicant's home state became the only structured state and decided
  // the property's jurisdiction. Anyone relocating to Seattle from out of state could not get
  // a lease at all. Where the applicant lives says nothing about where the property is.
  const states = [ctx.listingProperty?.state, ctx.leasedRoom?.state, ctx.submission?.state];
  for (const raw of states) {
    const value = raw?.trim();
    if (!value) continue;
    if (normalizedState(value)) return false; // A supported state wins outright.
    // Only a plausible state token vetoes. "n/a", "--" and free text are ignored rather than
    // silently refusing to generate a lease.
    if (US_STATE_TOKENS.has(value.toUpperCase())) return true;
  }
  return false;
}

function resolveFromHaystack(hay: string): JurisdictionKey | null {
  if (!hay.trim()) return null;
  // An explicitly out-of-scope state wins over every other signal, so an Oregon address on
  // "Washington St" cannot generate a lease citing the RCW. Matched as a STATE TOKEN, not as
  // free text: a bare /\bor\b/ hits the English word "or", which vetoed real Seattle
  // addresses on SW Oregon St and any address written "Unit A or B", generating no lease at
  // all. Both forms are only accepted where an address actually puts a state: after a comma,
  // or immediately before a ZIP. "SW Oregon St" is a street, not a state.
  // "Oregon" as a STATE, not as a street. Accepted in a state position (after a comma, before
  // a ZIP, or at the end of the text), and never when a street suffix follows it.
  if (/\boregon\s+(?:st|street|ave|avenue|blvd|dr|drive|rd|road|way|ln|lane|ct|pl|place)\b/i.test(hay)) {
    // A street named Oregon says nothing about the state.
  } else if (
    /,\s*(?:or|oregon)\b/i.test(hay) ||
    /\b(?:or|oregon)\s+\d{5}\b/i.test(hay) ||
    /\boregon\s*$/i.test(hay.trim()) ||
    /\bor\s*$/i.test(hay.trim())
  ) {
    return null;
  }
  const stateSignal = stateSignalFromHaystack(hay);
  if (SF_RE.test(hay)) return stateSignal && stateSignal !== "CA" ? { state: stateSignal } : { state: "CA", city: "san_francisco" };
  if (SEATTLE_RE.test(hay) || SEATTLE_STREET_RE.test(hay)) {
    return stateSignal && stateSignal !== "WA" ? { state: stateSignal } : { state: "WA", city: "seattle" };
  }
  // Seattle / SF metro ZIPs when address omits city/state (e.g. Brooklyn Ave NE, 98105).
  if (/\b981\d{2}\b/.test(hay)) return stateSignal && stateSignal !== "WA" ? { state: stateSignal } : { state: "WA", city: "seattle" };
  if (/\b941\d{2}\b/.test(hay)) return stateSignal && stateSignal !== "CA" ? { state: stateSignal } : { state: "CA", city: "san_francisco" };
  // State-only signal, no city match above: use the statewide template. Never assume the
  // state's largest city, which would put its municipal ordinance on someone else's lease.
  if (stateSignal) return { state: stateSignal };
  return null;
}

/** Resolve a property location to a supported state config and optional city overlay. */
export function resolveJurisdiction(ctx: LeaseJurisdictionInput): JurisdictionKey | null {
  // A structured state field is authoritative; no string heuristic can override it.
  if (explicitOutOfScopeState(ctx)) return null;
  const structured = structuredPropertyJurisdiction(ctx);
  if (structured) return structured;
  const propertyHay = propertyHaystack(ctx);
  if (propertyHay.trim()) return resolveFromHaystack(propertyHay) ?? zipJurisdiction(propertyHay);
  return resolveFromHaystack(haystackFromContext(ctx)) ?? zipJurisdiction(haystackFromContext(ctx));
}

/**
 * Last-resort state from a US ZIP code, for the two states PropLane generates leases in.
 *
 * A property saved without a structured state produced no jurisdiction at all, so its lease
 * preview came back empty and the manager was told to upload a document they did not need. The ZIP
 * is already in the haystack and a ZIP prefix maps to a state as a postal FACT — it is a lookup,
 * not an inference about the tenancy, and it decides only WHICH jurisdiction's template applies,
 * never what any clause says.
 *
 * Deliberately last: an explicit out-of-scope state, a structured state, and every address string
 * all still win, so this can only speak when nothing else did. It returns no city, so a
 * Seattle-specific overlay still requires the city to be recorded properly.
 */
function zipJurisdiction(haystack: string): JurisdictionKey | null {
  const zip = /\b(\d{5})(?:-\d{4})?\b/.exec(haystack)?.[1];
  if (!zip) return null;
  const prefix = Number(zip.slice(0, 3));
  if (prefix >= 980 && prefix <= 994) return jurisdictionKey("WA", null);
  if (prefix >= 900 && prefix <= 961) return jurisdictionKey("CA", null);
  return null;
}

/** Returns the applicable state config, using a city overlay only when it is registered. */
export function jurisdictionConfig(key: JurisdictionKey): LeaseJurisdictionTemplateConfig | null {
  const entry = LEASE_JURISDICTION_TEMPLATE_REGISTRY[normalizedState(key.state) ?? ""];
  if (!entry) return null;
  const city = normalizedCity(key.city);
  return city && entry.cities?.[city] ? entry.cities[city].config : entry.config;
}

type DisclosureCatalog = {
  jurisdiction_inheritance?: Record<string, string[]>;
};

const JURISDICTION_INHERITANCE = (disclosureClauseRules as DisclosureCatalog).jurisdiction_inheritance ?? {};

function registryEntry(key: JurisdictionKey): LeaseJurisdictionRegistryEntry | null {
  return LEASE_JURISDICTION_TEMPLATE_REGISTRY[normalizedState(key.state) ?? ""] ?? null;
}

/**
 * Disclosure scopes for this location. City inheritance comes directly from the rules
 * catalog; state locations receive the federal scope plus their registry-declared state scope.
 */
export function jurisdictionRuleScopes(key: JurisdictionKey): string[] {
  const entry = registryEntry(key);
  if (!entry) return [];
  const city = normalizedCity(key.city);
  const cityScope = city ? entry.cities?.[city]?.ruleScope : undefined;
  // Federal rules apply everywhere. Returning the raw inheritance list meant a jurisdiction
  // missing from jurisdiction_inheritance produced an EMPTY scope list, which filtered out
  // every rule, reported canCompleteLease true, and rendered a lease with no disclosures and
  // no warning. Fail toward disclosing, never toward silence.
  if (cityScope) {
    const inherited = JURISDICTION_INHERITANCE[cityScope] ?? [];
    return inherited.length ? [...inherited] : ["federal"];
  }
  return ["federal", entry.ruleScope];
}

export function jurisdictionKeyToLegacy(key: JurisdictionKey | null): LeaseJurisdiction {
  if (!key) return "unsupported";
  if (key.state === "CA" && key.city === "san_francisco") return "san_francisco";
  if (key.state === "WA" && key.city === "seattle") return "seattle";
  if (key.state === "CA") return "california";
  if (key.state === "WA") return "washington";
  return "unsupported";
}

/** Compatibility adapter for legacy callers. New code should use `resolveJurisdiction`. */
export function resolveLeaseJurisdiction(ctx: LeaseJurisdictionInput): LeaseJurisdiction {
  return jurisdictionKeyToLegacy(resolveJurisdiction(ctx));
}

export function jurisdictionLabel(j: LeaseJurisdiction): string {
  if (j === "seattle") return "Seattle, WA";
  if (j === "san_francisco") return "San Francisco, CA";
  if (j === "washington") return "Washington";
  if (j === "california") return "California";
  return "Unsupported";
}

export function isLeaseGenerationSupported(j: LeaseJurisdiction): boolean {
  return j !== "unsupported";
}

export function unsupportedJurisdictionMessage(j: LeaseJurisdiction = "unsupported"): string {
  void j;
  return "Lease generation is only available for California and Washington properties. Upload a PDF lease for other locations.";
}
