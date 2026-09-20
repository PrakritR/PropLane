/**
 * Default bathroom for the listing wizard, plus the shared-space readers older
 * listings still need.
 *
 * The Rooms step has `listing-house-defaults.ts`; Bathrooms used to keep their
 * defaults in a React `useState` that was forgotten on reload. They now live on
 * the submission (`bathroomDefaults`) and follow the same rule as the rooms: a
 * record follows the Default card for a field when its value equals the
 * default's or is empty, and lists compare by value. The wizard remembers hand
 * edits per field on top of that, so a blank default never sweeps up a value
 * set before the default was.
 *
 * Shared spaces no longer have a Default card: every shared space is its own
 * record. A listing saved while the card existed still carries a
 * `sharedSpaceDefaults` block; the readers below keep normalising and reading
 * it (the prefill path fills a blank space from it) but the wizard never
 * draws or writes it again.
 */
import type {
  ManagerBathroomSubmission,
  ManagerListingSubmissionV1,
  ManagerSharedSpaceSubmission,
} from "@/lib/manager-listing-submission";

/** Full, three-quarter (shower, no tub), half (toilet and sink), quarter (toilet only). */
export type BathroomType = "full" | "shower" | "half" | "quarter";

export type BathroomDefaults = {
  location: string;
  type: BathroomType | "";
  amenitiesText: string;
  detail: string;
  photoDataUrls: string[];
  videoDataUrl: string | null;
};
export type BathroomInheritField = keyof BathroomDefaults;
export const BATHROOM_INHERIT_FIELDS: readonly BathroomInheritField[] = ["location", "type", "amenitiesText", "detail", "photoDataUrls", "videoDataUrl"];

export type SharedSpaceDefaults = {
  location: string;
  detail: string;
  photoDataUrls: string[];
  videoDataUrl: string | null;
};
export const SHARED_SPACE_DEFAULT_FIELDS: readonly (keyof SharedSpaceDefaults)[] = ["location", "detail", "photoDataUrls", "videoDataUrl"];

export function emptyBathroomDefaults(): BathroomDefaults {
  return { location: "", type: "", amenitiesText: "", detail: "", photoDataUrls: [], videoDataUrl: null };
}

export function emptySharedSpaceDefaults(): SharedSpaceDefaults {
  return { location: "", detail: "", photoDataUrls: [], videoDataUrl: null };
}

type DefaultValue = string | string[] | null;

/** Nothing set — a blank, an empty list, or no clip. */
export function defaultValueIsUnset(value: DefaultValue | undefined): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return value.trim() === "";
}

/** Equal by value; two lists of the same URLs are the same list. */
export function defaultValuesMatch(a: DefaultValue | undefined, b: DefaultValue | undefined): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  return (a ?? "") === (b ?? "");
}

/**
 * Does the record follow the default for this field? True when the value
 * matches, when the record has nothing, and when the default has nothing —
 * with nothing to diverge from, a record cannot be overriding it.
 */
export function recordFollowsDefault(value: DefaultValue | undefined, defaultValue: DefaultValue | undefined): boolean {
  if (defaultValueIsUnset(defaultValue)) return true;
  if (defaultValueIsUnset(value)) return true;
  return defaultValuesMatch(value, defaultValue);
}

/* ── bathrooms ── */

/** A bathroom's type, read back from the fixtures that define it. */
export function bathroomTypeOf(bath: ManagerBathroomSubmission): BathroomType {
  if (bath.bathtub) return "full";
  if (bath.shower) return "shower";
  if (bath.sink !== false) return "half";
  return "quarter";
}

export function writeBathroomType(bath: ManagerBathroomSubmission, type: BathroomType): ManagerBathroomSubmission {
  return { ...bath, toilet: true, sink: type !== "quarter", shower: type === "full" || type === "shower", bathtub: type === "full" };
}

export function bathroomFieldValue(bath: ManagerBathroomSubmission, field: BathroomInheritField): DefaultValue {
  switch (field) {
    case "location":
      return bath.location ?? "";
    case "type":
      return bathroomTypeOf(bath);
    case "amenitiesText":
      return bath.amenitiesText ?? "";
    case "detail":
      return bath.detail ?? "";
    case "photoDataUrls":
      return bath.photoDataUrls ?? [];
    case "videoDataUrl":
      return bath.videoDataUrl ?? null;
  }
}

export function writeBathroomField(bath: ManagerBathroomSubmission, field: BathroomInheritField, value: DefaultValue): ManagerBathroomSubmission {
  switch (field) {
    case "location":
      return { ...bath, location: typeof value === "string" ? value : "" };
    case "type":
      return typeof value === "string" && value ? writeBathroomType(bath, value as BathroomType) : bath;
    case "amenitiesText":
      return { ...bath, amenitiesText: typeof value === "string" ? value : "" };
    case "detail":
      return { ...bath, detail: typeof value === "string" ? value : "" };
    case "photoDataUrls":
      return { ...bath, photoDataUrls: Array.isArray(value) ? [...value] : [] };
    case "videoDataUrl":
      return { ...bath, videoDataUrl: typeof value === "string" && value ? value : null };
  }
}

/** A fresh bathroom card copies every default the Default bathroom has set. */
export function applyBathroomDefaults(bath: ManagerBathroomSubmission, defaults: BathroomDefaults): ManagerBathroomSubmission {
  let next = bath;
  for (const field of BATHROOM_INHERIT_FIELDS) {
    if (!defaultValueIsUnset(defaults[field])) next = writeBathroomField(next, field, defaults[field]);
  }
  return next;
}

/* ── shared spaces ── */

export function sharedSpaceFieldValue(space: ManagerSharedSpaceSubmission, field: keyof SharedSpaceDefaults): DefaultValue {
  switch (field) {
    case "location":
      return space.location ?? "";
    case "detail":
      return space.detail ?? "";
    case "photoDataUrls":
      return space.photoDataUrls ?? [];
    case "videoDataUrl":
      return space.videoDataUrl ?? null;
  }
}

export function writeSharedSpaceField(space: ManagerSharedSpaceSubmission, field: keyof SharedSpaceDefaults, value: DefaultValue): ManagerSharedSpaceSubmission {
  switch (field) {
    case "location":
      return { ...space, location: typeof value === "string" ? value : "" };
    case "detail":
      return { ...space, detail: typeof value === "string" ? value : "" };
    case "photoDataUrls":
      return { ...space, photoDataUrls: Array.isArray(value) ? [...value] : [] };
    case "videoDataUrl":
      return { ...space, videoDataUrl: typeof value === "string" && value ? value : null };
  }
}

/* ── inference for listings saved before the defaults existed ── */

function sharedByAll<T>(values: readonly DefaultValue[], out: T): T | null {
  if (values.length === 0) return null;
  const first = values[0]!;
  if (defaultValueIsUnset(first)) return null;
  return values.every((v) => defaultValuesMatch(v, first)) ? out : null;
}

function mostCommonText(values: readonly DefaultValue[]): string {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (typeof v !== "string" || defaultValueIsUnset(v)) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: { value: string; n: number } | null = null;
  for (const [value, n] of counts) if (!best || n > best.n) best = { value, n };
  return best?.value ?? "";
}

/**
 * What the Default bathroom is: whatever the listing stored, over a guess from
 * the bathrooms it has. Facts take the most common value; a photo list or clip
 * is inferred only when every bathroom carries the same one.
 */
export function bathroomDefaultsForSubmission(sub: Pick<ManagerListingSubmissionV1, "bathrooms" | "bathroomDefaults">): BathroomDefaults {
  const baths = sub.bathrooms ?? [];
  const inferred = emptyBathroomDefaults();
  if (baths.length > 0) {
    inferred.location = mostCommonText(baths.map((b) => bathroomFieldValue(b, "location")));
    // Every bathroom HAS a type, so a majority would crown one card's fixtures
    // "the default" on a brand-new listing and mark the other cards as their
    // own before the manager touched anything. Only a type every card shares.
    const types = baths.map((b) => bathroomFieldValue(b, "type"));
    inferred.type = (sharedByAll(types, types[0] as string) ?? "") as BathroomType | "";
    inferred.amenitiesText = mostCommonText(baths.map((b) => bathroomFieldValue(b, "amenitiesText")));
    inferred.detail = mostCommonText(baths.map((b) => bathroomFieldValue(b, "detail")));
    const photos = baths.map((b) => bathroomFieldValue(b, "photoDataUrls"));
    inferred.photoDataUrls = sharedByAll(photos, [...(photos[0] as string[])]) ?? [];
    const clips = baths.map((b) => bathroomFieldValue(b, "videoDataUrl"));
    inferred.videoDataUrl = sharedByAll(clips, clips[0] as string) ?? null;
  }
  return { ...inferred, ...(sub.bathroomDefaults ?? {}) };
}

/**
 * Read-only: what a listing's stored `sharedSpaceDefaults` block says, over a
 * guess from its spaces. The wizard draws no Default card for shared spaces
 * and never writes this block; it stays so an older listing keeps reading
 * exactly as it did (the prefill path fills a blank space from it).
 */
export function sharedSpaceDefaultsForSubmission(sub: Pick<ManagerListingSubmissionV1, "sharedSpaces" | "sharedSpaceDefaults">): SharedSpaceDefaults {
  const spaces = sub.sharedSpaces ?? [];
  const inferred = emptySharedSpaceDefaults();
  if (spaces.length > 0) {
    inferred.location = mostCommonText(spaces.map((s) => sharedSpaceFieldValue(s, "location")));
    inferred.detail = mostCommonText(spaces.map((s) => sharedSpaceFieldValue(s, "detail")));
    const photos = spaces.map((s) => sharedSpaceFieldValue(s, "photoDataUrls"));
    inferred.photoDataUrls = sharedByAll(photos, [...(photos[0] as string[])]) ?? [];
    const clips = spaces.map((s) => sharedSpaceFieldValue(s, "videoDataUrl"));
    inferred.videoDataUrl = sharedByAll(clips, clips[0] as string) ?? null;
  }
  return { ...inferred, ...(sub.sharedSpaceDefaults ?? {}) };
}
