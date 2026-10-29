/**
 * Structured house details — the door code, the Wi-Fi, the trash day, the rules.
 *
 * Before this, a manager typed all of it into three free-text boxes and the
 * product could do nothing with it: no copy button on a password buried in a
 * paragraph, no labelled row in the move-in email, and an assistant that could
 * only quote the whole blob back at a resident.
 *
 * This module is the ONE description of what a house detail is. The manager
 * editor, the resident read view, the move-in email and the resident assistant
 * all render from {@link HOUSE_INFO_SECTIONS}, so a field added here shows up
 * everywhere and the surfaces cannot drift apart.
 *
 * SECURITY: every field here is resident-only. None of it may reach a public
 * listing — `publicListingProjection` is an allowlist, so `houseInfo` is
 * excluded by construction and `tests/unit/public-listing-projection.test.ts`
 * proves it stays that way.
 */

export type HouseInfoSectionId =
  | "access"
  | "wifi"
  | "trash"
  | "rules"
  | "contacts"
  | "laundry"
  | "safety"
  /** What a resident does on the way out: trash, keys, lights (Check-in tab, checkout step). */
  | "checkout"
  /**
   * STAFF ONLY: pantry, lockbox and mailbox codes and notes. Managers with Properties access and
   * PropLane staff read it; a resident, guest, owner viewer, vendor, the public page, a printable and
   * every outbound message never do (`houseInfoWithoutInternal`, `HOUSE_INTERNAL_SECTION_ID`).
   */
  | "internal";

/** The one staff-only section. Everything that serves a non-staff reader strips it by this id. */
export const HOUSE_INTERNAL_SECTION_ID = "internal" satisfies HouseInfoSectionId;

/**
 * `timeRange` owns TWO stored keys (`key` and `pairKey`) and renders as one
 * labelled pair — quiet hours is a range, not two unrelated times.
 */
export type HouseInfoFieldKind = "text" | "textarea" | "time" | "timeRange" | "select" | "url" | "count";

export type HouseInfoField = {
  key: string;
  label: string;
  kind: HouseInfoFieldKind;
  /** Second stored key, `timeRange` only. */
  pairKey?: string;
  placeholder?: string;
  hint?: string;
  /**
   * Suggested values for a `select`. A stored value that is not in this list is
   * still kept and offered — a migrated house whose smoking rule reads
   * "prohibited within 25 feet of any door" must not be silently rewritten into
   * the nearest preset.
   */
  options?: readonly string[];
  /** Resident read view offers a Copy button and a monospace value. */
  copyable?: boolean;
  /**
   * A SECRET: a door or gate code, the Wi-Fi password, the alarm. Only a verified current resident of
   * the house may be told (the move-in lock still applies), and no automated group post, template
   * preview for a group, public page or printable ever carries one (`houseInfoSecretValues`).
   */
  secret?: boolean;
  /**
   * A manager-side setting that rides the house record: never drawn to a resident, never printed on
   * a public page or door card (`houseInfoRenderSections`, `buildHousePublicPage` both skip it).
   */
  internal?: boolean;
  /** `count` only: the stepper's bounds. */
  min?: number;
  max?: number;
};

export type HouseInfoSectionSpec = {
  id: HouseInfoSectionId;
  label: string;
  /** Shown under the section heading in the manager editor only. */
  blurb?: string;
  /** Collapsed and out of the way until it has content. */
  optional?: boolean;
  fields: readonly HouseInfoField[];
};

/** Shown on Move-in (whole house), not the House details resident list. */
export const HOUSE_INFO_MOVE_IN_SECTION_IDS: readonly HouseInfoSectionId[] = ["access", "wifi", "checkout"];

export const HOUSE_INFO_SECTIONS: readonly HouseInfoSectionSpec[] = [
  {
    id: "access",
    label: "Getting in",
    blurb: "Shown to a resident once their residency is established. Never appears on a public listing.",
    fields: [
      {
        key: "doorCode",
        label: "Front door code",
        kind: "text",
        placeholder: "001000",
        hint: "Residents get a copy button for this.",
        copyable: true,
        secret: true,
      },
      { key: "gateCode", label: "Gate or building code", kind: "text", placeholder: "#4821 then the call button", copyable: true, secret: true },
      { key: "keyPickup", label: "Lockbox / key pickup", kind: "text", placeholder: "Lockbox left of the door — same code", secret: true },
      { key: "parking", label: "Parking", kind: "text", placeholder: "Street parking, no permit needed" },
      {
        key: "notes",
        label: "Other access notes",
        kind: "textarea",
        placeholder: "Side gate sticks — lift and push. Package room is the second door on the left.",
        // Free text is where a manager types a code: it unlocks and masks with the codes.
        secret: true,
      },
    ],
  },
  {
    id: "wifi",
    label: "Wi-Fi",
    fields: [
      { key: "network", label: "Network name", kind: "text", placeholder: "4709A", copyable: true },
      { key: "password", label: "Password", kind: "text", placeholder: "a password residents can copy", copyable: true, secret: true },
      { key: "notes", label: "Notes", kind: "text", placeholder: "Guest network, printer name, mesh point in the hallway…" },
    ],
  },
  {
    id: "trash",
    label: "Trash & cleaning",
    fields: [
      {
        key: "day",
        label: "Trash day",
        kind: "select",
        options: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
      },
      {
        key: "recycling",
        label: "Recycling day",
        kind: "select",
        options: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
      },
      { key: "binLocation", label: "Bin location", kind: "text", placeholder: "Side of the house, behind the gate" },
      {
        key: "cleaningCadence",
        label: "Professional cleaning",
        kind: "select",
        options: ["Weekly", "Every two weeks", "Monthly", "None"],
      },
      {
        key: "betweenCleanings",
        label: "Between cleanings, residents…",
        kind: "textarea",
        placeholder: "Vacuum/mop per the posted schedule. Keep common areas clear.",
      },
    ],
  },
  {
    id: "rules",
    label: "House rules",
    fields: [
      { key: "quietFrom", pairKey: "quietTo", label: "Quiet hours", kind: "timeRange" },
      {
        key: "smoking",
        label: "Smoking",
        kind: "select",
        options: [
          "No smoking, vaping or cannabis anywhere",
          "Outside only",
          "Designated area only",
          "Allowed",
        ],
      },
      {
        key: "guests",
        label: "Guests & overnight",
        kind: "select",
        options: [
          "Guests welcome, no overnight stays",
          "Overnight guests up to 2 nights",
          "Overnight guests up to 7 nights",
          "Ask the manager first",
        ],
      },
      {
        key: "pets",
        label: "Pets",
        kind: "select",
        options: ["No pets", "Cats only", "Dogs under 25 lb", "Case by case"],
      },
      {
        key: "kitchen",
        label: "Kitchen & dining",
        kind: "textarea",
        placeholder: "Clean dishes, pots and counters after each use. Label your food.",
      },
      {
        key: "bathroom",
        label: "Bathroom",
        kind: "textarea",
        placeholder: "Keep your assigned bathroom clean. Remove personal items from shared spaces.",
      },
      {
        key: "commonAreas",
        label: "Common areas",
        kind: "textarea",
        placeholder: "Do not leave belongings in common areas for more than 24 hours.",
      },
      { key: "other", label: "Other rules", kind: "textarea", placeholder: "Anything not covered above." },
      {
        key: "escalateAfter",
        label: "Escalate after complaints in 30 days",
        kind: "count",
        min: 1,
        max: 10,
        internal: true,
      },
    ],
  },
  {
    id: "contacts",
    label: "Contacts & links",
    fields: [
      {
        key: "groupChatUrl",
        label: "House group chat",
        kind: "url",
        placeholder: "https://chat.whatsapp.com/…",
        hint: "Residents see a “Join the house chat” link, not a raw URL.",
      },
      { key: "manager", label: "Manager contact", kind: "text", placeholder: "Text PropLane, or call (206) 555-0142" },
      { key: "emergency", label: "Emergency / after hours", kind: "text", placeholder: "(206) 555-0142" },
      { key: "onSite", label: "On-site contact", kind: "text", placeholder: "Marisol, unit 1 — knocks OK before 9pm" },
    ],
  },
  {
    id: "laundry",
    label: "Laundry & appliances",
    optional: true,
    fields: [
      { key: "location", label: "Laundry location", kind: "text", placeholder: "Basement, coin-free" },
      { key: "hours", label: "Hours", kind: "text", placeholder: "8am – 10pm" },
      {
        key: "quirks",
        label: "Appliance quirks",
        kind: "textarea",
        placeholder: "Dishwasher needs the door held for 3 seconds to start.",
      },
    ],
  },
  {
    id: "safety",
    label: "Safety",
    optional: true,
    fields: [
      { key: "shutoffs", label: "Water / gas / breaker shutoff", kind: "text", placeholder: "Breaker panel in the hall closet" },
      { key: "alarm", label: "Alarm", kind: "text", placeholder: "Keypad by the front door", copyable: true, secret: true },
      { key: "extinguisher", label: "Extinguisher & first aid", kind: "text", placeholder: "Under the kitchen sink" },
    ],
  },
  {
    id: "checkout",
    label: "Checkout",
    fields: [
      { key: "timeNote", label: "Checkout time", kind: "text", placeholder: "By 11:00 AM on your last day" },
      { key: "trash", label: "Trash", kind: "text", placeholder: "Take your trash to the bin" },
      { key: "keys", label: "Keys and doors", kind: "text", placeholder: "Leave the room door unlocked" },
      { key: "lights", label: "Lights and windows", kind: "text", placeholder: "Lights off, windows closed" },
      { key: "other", label: "Anything else", kind: "textarea", placeholder: "Strip the bed and leave the linens by the door." },
    ],
  },
  {
    id: "internal",
    label: "Internal (staff only)",
    fields: [
      { key: "pantryCode", label: "Pantry code", kind: "text", copyable: true, secret: true, internal: true },
      { key: "lockboxCode", label: "Lockbox code", kind: "text", copyable: true, secret: true, internal: true },
      { key: "mailboxCode", label: "Mailbox code", kind: "text", copyable: true, secret: true, internal: true },
      { key: "notes", label: "Notes", kind: "textarea", secret: true, internal: true },
    ],
  },
] as const;

/** Every stored section is a flat bag of strings — see {@link HOUSE_INFO_SECTIONS}. */
export type HouseInfoSectionValues = Record<string, string>;

export type HouseInfoV1 = {
  v: 1;
  access: HouseInfoSectionValues;
  wifi: HouseInfoSectionValues;
  trash: HouseInfoSectionValues;
  rules: HouseInfoSectionValues;
  contacts: HouseInfoSectionValues;
  laundry: HouseInfoSectionValues;
  safety: HouseInfoSectionValues;
  checkout: HouseInfoSectionValues;
  /** Staff only: see {@link HOUSE_INTERNAL_SECTION_ID}. Empty on anything a non-staff reader gets. */
  internal: HouseInfoSectionValues;
  /** The escape hatch, and where unmatched legacy text lands verbatim. */
  other: string;
  /**
   * What the free-text boxes held when the manager applied the split. Kept so
   * an accidental migration is recoverable, and so nothing is destroyed by a
   * parser that guessed wrong.
   */
  migratedFrom?: { at: string; generalHouseInfo: string; houseRulesText: string };
};

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSection(raw: unknown, spec: HouseInfoSectionSpec): HouseInfoSectionValues {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: HouseInfoSectionValues = {};
  for (const field of spec.fields) {
    for (const key of fieldKeys(field)) {
      const value = asTrimmedString(source[key]);
      if (!value) continue;
      if (field.kind === "count") {
        // A count is a whole number inside the stepper's bounds, or nothing: never "lots".
        const n = Number(value);
        if (!Number.isInteger(n)) continue;
        out[key] = String(Math.min(field.max ?? 99, Math.max(field.min ?? 0, n)));
        continue;
      }
      out[key] = value;
    }
  }
  return out;
}

/** Both stored keys of a `timeRange`, or the single key of everything else. */
export function fieldKeys(field: HouseInfoField): string[] {
  return field.pairKey ? [field.key, field.pairKey] : [field.key];
}

/**
 * Coerce anything read off a stored submission into a complete, empty-string
 * shaped {@link HouseInfoV1}. Unknown keys are dropped: a field that is no
 * longer in the schema stops being written, and an empty result is
 * indistinguishable from a property that never had house info at all.
 */
export function normalizeHouseInfo(raw: unknown): HouseInfoV1 {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out = { v: 1, other: asTrimmedString(source.other) } as HouseInfoV1;
  for (const spec of HOUSE_INFO_SECTIONS) {
    out[spec.id] = normalizeSection(source[spec.id], spec);
  }
  const migrated = source.migratedFrom;
  if (migrated && typeof migrated === "object" && !Array.isArray(migrated)) {
    const m = migrated as Record<string, unknown>;
    out.migratedFrom = {
      at: asTrimmedString(m.at),
      generalHouseInfo: typeof m.generalHouseInfo === "string" ? m.generalHouseInfo : "",
      houseRulesText: typeof m.houseRulesText === "string" ? m.houseRulesText : "",
    };
  }
  return out;
}

export function emptyHouseInfo(): HouseInfoV1 {
  return normalizeHouseInfo(null);
}

/**
 * The house details with the staff-only section emptied. The one function every non-staff reader
 * (resident payload, assistant, printable, public projection, outbound message) goes through, so a
 * new reader cannot forget the section: it is removed from the DATA, not hidden in the markup.
 */
export function houseInfoWithoutInternal(info: HouseInfoV1 | null | undefined): HouseInfoV1 {
  const normalized = normalizeHouseInfo(info);
  return { ...normalized, internal: {} };
}

/**
 * The house details with every SECRET field emptied (door, gate, lockbox, Wi-Fi password, alarm, and
 * the staff section): what a resident is sent before the check-in reveal. Removed from the data, so
 * the browser never holds a code it was not yet meant to show.
 */
export function houseInfoWithoutSecrets(info: HouseInfoV1 | null | undefined): HouseInfoV1 {
  const out = houseInfoWithoutInternal(info);
  for (const spec of HOUSE_INFO_SECTIONS) {
    const bag = { ...out[spec.id] };
    for (const field of spec.fields) {
      if (field.secret) delete bag[field.key];
    }
    out[spec.id] = bag;
  }
  return out;
}

/** The staff card's rows: pantry, lockbox and mailbox codes and notes. Empty values are dropped. */
export function houseInfoInternalRows(info: HouseInfoV1 | null | undefined): HouseInfoRow[] {
  if (!info) return [];
  const spec = HOUSE_INFO_SECTIONS.find((s) => s.id === HOUSE_INTERNAL_SECTION_ID);
  if (!spec) return [];
  const rows: HouseInfoRow[] = [];
  for (const field of spec.fields) {
    const value = getHouseInfoValue(info, HOUSE_INTERNAL_SECTION_ID, field.key);
    if (value) rows.push({ label: field.label, value, copyable: Boolean(field.copyable) });
  }
  return rows;
}

export function getHouseInfoValue(info: HouseInfoV1, sectionId: HouseInfoSectionId, key: string): string {
  return info[sectionId]?.[key] ?? "";
}

export function setHouseInfoValue(
  info: HouseInfoV1,
  sectionId: HouseInfoSectionId,
  key: string,
  value: string,
): HouseInfoV1 {
  const section = { ...info[sectionId] };
  if (value.trim()) section[key] = value;
  else delete section[key];
  return { ...info, [sectionId]: section };
}

/** Filled / total for a section — drives the "2 of 5" pill in the editor. */
export function houseInfoSectionCount(
  info: HouseInfoV1,
  spec: HouseInfoSectionSpec,
): { filled: number; total: number } {
  let filled = 0;
  for (const field of spec.fields) {
    // A time RANGE counts once, and only when both ends are set — half a range
    // is not a rule anyone can follow.
    if (field.pairKey) {
      if (getHouseInfoValue(info, spec.id, field.key) && getHouseInfoValue(info, spec.id, field.pairKey)) filled += 1;
      continue;
    }
    if (getHouseInfoValue(info, spec.id, field.key)) filled += 1;
  }
  return { filled, total: spec.fields.length };
}

export function houseInfoSectionIsEmpty(info: HouseInfoV1, spec: HouseInfoSectionSpec): boolean {
  return houseInfoSectionCount(info, spec).filled === 0;
}

/** House details → For residents (rules live on The house; access/Wi-Fi on Move-in). */
export function houseInfoResidentsReadTabSections(
  info: HouseInfoV1,
): readonly HouseInfoSectionSpec[] {
  return HOUSE_INFO_SECTIONS.filter(
    (spec) =>
      spec.id !== "rules" &&
      spec.id !== HOUSE_INTERNAL_SECTION_ID &&
      !HOUSE_INFO_MOVE_IN_SECTION_IDS.includes(spec.id) &&
      (!spec.optional || !houseInfoSectionIsEmpty(info, spec)),
  );
}

/** True when nothing at all is set — the caller should fall back to legacy text. */
export function houseInfoIsEmpty(info: HouseInfoV1 | null | undefined): boolean {
  if (!info) return true;
  if (info.other.trim()) return false;
  return HOUSE_INFO_SECTIONS.every((spec) => houseInfoSectionIsEmpty(info, spec));
}

/* ────────────────────────────  read-side rendering  ──────────────────────── */

export type HouseInfoRow = { label: string; value: string; copyable: boolean; url?: string };
export type HouseInfoRenderSection = { id: HouseInfoSectionId; label: string; rows: HouseInfoRow[] };

function formatTimeLabel(value: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return value.trim();
  const hour = Number(match[1]);
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return value.trim();
  const suffix = hour < 12 ? "AM" : "PM";
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${match[2]} ${suffix}`;
}

/**
 * The sections a resident should see, with empty fields and empty sections
 * already dropped. One function so the portal, the move-in email and the
 * assistant never disagree about what "filled in" means.
 */
export function houseInfoRenderSections(info: HouseInfoV1 | null | undefined): HouseInfoRenderSection[] {
  if (!info) return [];
  const out: HouseInfoRenderSection[] = [];
  for (const spec of HOUSE_INFO_SECTIONS) {
    const rows: HouseInfoRow[] = [];
    for (const field of spec.fields) {
      // Manager-side settings (escalation threshold) are not house details a resident reads.
      if (field.internal) continue;
      if (field.pairKey) {
        const from = getHouseInfoValue(info, spec.id, field.key);
        const to = getHouseInfoValue(info, spec.id, field.pairKey);
        if (from && to) rows.push({ label: field.label, value: `${formatTimeLabel(from)} – ${formatTimeLabel(to)}`, copyable: false });
        continue;
      }
      const value = getHouseInfoValue(info, spec.id, field.key);
      if (!value) continue;
      rows.push({
        label: field.label,
        value: field.kind === "time" ? formatTimeLabel(value) : value,
        copyable: Boolean(field.copyable),
        ...(field.kind === "url" && /^https?:\/\//i.test(value) ? { url: value } : {}),
      });
    }
    if (rows.length > 0) out.push({ id: spec.id, label: spec.label, rows });
  }
  return out;
}

/**
 * Every SECRET value on the house (door and gate codes, lockbox, Wi-Fi password, alarm). A group
 * post, a public model and a prospect or pre-assignment vendor text are checked against this list
 * before they leave: `containsHouseSecret`.
 */
export function houseInfoSecretValues(info: HouseInfoV1 | null | undefined): string[] {
  if (!info) return [];
  const out: string[] = [];
  for (const spec of HOUSE_INFO_SECTIONS) {
    for (const field of spec.fields) {
      if (!field.secret) continue;
      const value = getHouseInfoValue(info, spec.id, field.key).trim();
      if (value) out.push(value);
    }
  }
  return out;
}

function squashForSecretMatch(value: string): string {
  return value.toLowerCase().replace(/[\s\-_.]+/g, "");
}

/**
 * Does `text` carry any secret of this house? Case and spacing blind ("0 0 1 0 0 0" and "001000" are
 * the same code), and a secret shorter than four characters is matched only as a whole token so a
 * two-digit code does not flag every number.
 */
export function containsHouseSecret(
  text: string,
  info: HouseInfoV1 | null | undefined,
  /** Secrets that live outside `houseInfo` (a room's door code): `listingRoomSecretValues`. */
  extraSecrets: readonly string[] = [],
): boolean {
  const haystack = squashForSecretMatch(text);
  if (!haystack) return false;
  for (const secret of [...houseInfoSecretValues(info), ...extraSecrets]) {
    const needle = squashForSecretMatch(secret);
    if (!needle) continue;
    if (needle.length < 4) {
      const token = new RegExp(`(^|[^a-z0-9])${secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
      if (token.test(text)) return true;
      continue;
    }
    if (haystack.includes(needle)) return true;
  }
  return false;
}

/** The manager's complaint threshold for this house (1-10), or null when none is set. */
export function houseInfoEscalateAfter(info: HouseInfoV1 | null | undefined): number | null {
  if (!info) return null;
  const n = Number(getHouseInfoValue(info, "rules", "escalateAfter"));
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** The quiet-hour window as stored ("22:00" to "08:00"), or null unless both ends are set. */
export function houseInfoQuietWindow(info: HouseInfoV1 | null | undefined): { from: string; to: string } | null {
  if (!info) return null;
  const from = getHouseInfoValue(info, "rules", "quietFrom");
  const to = getHouseInfoValue(info, "rules", "quietTo");
  return from && to ? { from, to } : null;
}

/** One-line row summary for list rows (not “N of M filled”). */
export function houseInfoSectionSummaryLine(info: HouseInfoV1, spec: HouseInfoSectionSpec): string {
  if (houseInfoSectionIsEmpty(info, spec)) return "Nothing added yet";
  const section = houseInfoRenderSections(info).find((s) => s.id === spec.id);
  if (!section?.rows.length) return "Filled in";
  const [first] = section.rows;
  const tail = section.rows.length > 1 ? ` · +${section.rows.length - 1}` : "";
  const value = first.value.length > 48 ? `${first.value.slice(0, 45)}…` : first.value;
  return `${first.label}: ${value}${tail}`;
}

/** Plain-text rendering for the move-in email and any non-HTML surface. */
export function houseInfoToPlainText(info: HouseInfoV1 | null | undefined): string {
  const sections = houseInfoRenderSections(info);
  const blocks = sections.map((section) =>
    [`${section.label}:`, ...section.rows.map((row) => `  ${row.label}: ${row.value}`)].join("\n"),
  );
  const other = info?.other.trim();
  if (other) blocks.push(other);
  return blocks.join("\n\n");
}

/* ─────────────────────────────  legacy migration  ─────────────────────────── */

export type HouseInfoSplitMatch = {
  sectionId: HouseInfoSectionId;
  key: string;
  /** The schema label, so the review UI can name what it is proposing. */
  label: string;
  value: string;
};

export type HouseInfoSplit = {
  info: HouseInfoV1;
  matched: HouseInfoSplitMatch[];
  /** Blocks recognised as PropLane's own portal help — proposed for removal, never removed here. */
  portalHelp: string[];
  /** Everything the parser did not recognise, in its original order, verbatim. */
  leftover: string;
};

type LabelRule = {
  test: RegExp;
  sectionId: HouseInfoSectionId;
  key: string;
  /** Consume the WHOLE line rather than the part after the colon. */
  wholeLine?: boolean;
};

/**
 * Deterministic label matching only — no model call. A rule fires on the label
 * at the head of a line, and the value is what follows the colon. Order
 * matters: the first match wins, so put the specific rule above the general
 * one ("wifi password" before "password").
 */
const LABEL_RULES: readonly LabelRule[] = [
  { test: /^(front\s*door|door|entry|keypad)\s*code$/i, sectionId: "access", key: "doorCode" },
  { test: /^(gate|building|call\s*box)\s*code$/i, sectionId: "access", key: "gateCode" },
  { test: /^(lock\s*box|lockbox|key\s*pick\s*-?\s*up|keys)$/i, sectionId: "access", key: "keyPickup" },
  { test: /^parking$/i, sectionId: "access", key: "parking" },
  { test: /^wi-?fi\s*(username|network|name|ssid)$/i, sectionId: "wifi", key: "network" },
  { test: /^wi-?fi\s*password$/i, sectionId: "wifi", key: "password" },
  { test: /^(ssid|network\s*name)$/i, sectionId: "wifi", key: "network" },
  { test: /^(house\s*)?(group\s*chat|groupchat|whats\s*app|whatsapp)$/i, sectionId: "contacts", key: "groupChatUrl" },
  { test: /^(emergency|after\s*hours)(\s*contact)?$/i, sectionId: "contacts", key: "emergency" },
  { test: /^(on-?site|house)\s*contact$/i, sectionId: "contacts", key: "onSite" },
  { test: /^quiet\s*hours$/i, sectionId: "rules", key: "quietFrom" },
  { test: /^smoking$/i, sectionId: "rules", key: "smoking" },
  { test: /^pets?$/i, sectionId: "rules", key: "pets" },
  { test: /^(guests?|visitors?)$/i, sectionId: "rules", key: "guests" },
  { test: /^kitchen(\s*&?\s*dining)?$/i, sectionId: "rules", key: "kitchen" },
  { test: /^bathrooms?$/i, sectionId: "rules", key: "bathroom" },
  { test: /^common\s*areas?$/i, sectionId: "rules", key: "commonAreas" },
  { test: /^(noise\s*&?\s*conflict|respect)$/i, sectionId: "rules", key: "other" },
  { test: /^cleaning(\s*schedule)?$/i, sectionId: "trash", key: "cleaningCadence" },
  { test: /^trash(\s*&?\s*recycling)?$/i, sectionId: "trash", key: "binLocation" },
  { test: /^(recycling|compost)$/i, sectionId: "trash", key: "recycling" },
  { test: /^laundry$/i, sectionId: "laundry", key: "location" },
];

/**
 * Text PropLane now says for itself. A manager who typed the portal tour into
 * their house info gets it offered for removal — but the paragraphs are handed
 * back so the review screen can show exactly what would go, and keeping them is
 * one click.
 */
const PORTAL_HELP_PATTERNS: readonly RegExp[] = [
  /report\s+maintenance/i,
  /pay\s+rent,\s*review\s+your\s+lease/i,
  /^services\s*:?\s*$/i,
  /^payments?,?\s*lease\s*(&|and)\s*inbox\s*:?\s*$/i,
  /request\s+add-?ons?\s+directly\s+through\s+the\s+portal/i,
];

function looksLikePortalHelp(block: string): boolean {
  return PORTAL_HELP_PATTERNS.some((pattern) => pattern.test(block.trim()));
}

/** Strip a leading bullet and any decorative emoji so the label is matchable. */
function stripBullet(line: string): string {
  return line
    .replace(/^\s*[*\-•]\s*/, "")
    // Emoji and other pictographs a manager pasted in front of the label.
    .replace(/^[^\p{L}\p{N}(]+/u, "")
    .trim();
}

function splitLabel(line: string): { label: string; value: string } | null {
  const clean = stripBullet(line);
  const idx = clean.indexOf(":");
  if (idx <= 0) return null;
  const label = clean.slice(0, idx).trim();
  const value = clean.slice(idx + 1).trim();
  if (!label || !value) return null;
  // A label is a label, not a sentence that happens to contain a colon.
  if (label.split(/\s+/).length > 4) return null;
  return { label, value };
}

const TIME_RANGE = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;

/** "10:00 PM - 8:00 AM" → `{ from: "22:00", to: "08:00" }`, or null. */
export function parseQuietHours(value: string): { from: string; to: string } | null {
  const m = TIME_RANGE.exec(value);
  if (!m) return null;
  const to24 = (hourRaw: string, minuteRaw: string | undefined, meridiem: string | undefined): string | null => {
    let hour = Number(hourRaw);
    if (!Number.isFinite(hour)) return null;
    const minute = minuteRaw ?? "00";
    const mer = meridiem?.toLowerCase();
    if (mer === "pm" && hour < 12) hour += 12;
    if (mer === "am" && hour === 12) hour = 0;
    if (hour > 23) return null;
    return `${String(hour).padStart(2, "0")}:${minute}`;
  };
  const from = to24(m[1], m[2], m[3]);
  const to = to24(m[4], m[5], m[6]);
  if (!from || !to) return null;
  return { from, to };
}

/**
 * Propose a split of the legacy free-text boxes into sections.
 *
 * NOTHING is lost: every line either matches a rule, is recognised as portal
 * help, or is passed through to `leftover` verbatim and in order. The caller
 * shows this to the manager and only writes it if they apply it.
 */
export function parseLegacyHouseText(input: {
  generalHouseInfo?: string | null;
  houseRulesText?: string | null;
  wifiNetworkName?: string | null;
  wifiPassword?: string | null;
}): HouseInfoSplit {
  let info = emptyHouseInfo();
  const matched: HouseInfoSplitMatch[] = [];
  const portalHelp: string[] = [];
  const leftoverLines: string[] = [];

  const labelOf = (sectionId: HouseInfoSectionId, key: string): string => {
    const spec = HOUSE_INFO_SECTIONS.find((s) => s.id === sectionId);
    const field = spec?.fields.find((f) => f.key === key || f.pairKey === key);
    return field?.label ?? key;
  };

  const record = (
    sectionId: HouseInfoSectionId,
    key: string,
    value: string,
    // What the review screen should show, when the stored value is not what the
    // manager would recognise (a 24-hour time, say).
    options: { displayValue?: string; silent?: boolean } = {},
  ) => {
    // First writer wins, so a door code repeated in two boxes lands once.
    if (getHouseInfoValue(info, sectionId, key)) return false;
    info = setHouseInfoValue(info, sectionId, key, value);
    if (!options.silent) {
      matched.push({ sectionId, key, label: labelOf(sectionId, key), value: options.displayValue ?? value });
    }
    return true;
  };

  // The dead structured Wi-Fi pair, read once so a house that still has it does
  // not have to retype it.
  const legacyNetwork = asTrimmedString(input.wifiNetworkName);
  const legacyPassword = asTrimmedString(input.wifiPassword);
  if (legacyNetwork) record("wifi", "network", legacyNetwork);
  if (legacyPassword) record("wifi", "password", legacyPassword);

  const blocks: string[] = [];
  for (const raw of [input.generalHouseInfo, input.houseRulesText]) {
    const text = typeof raw === "string" ? raw : "";
    if (!text.trim()) continue;
    for (const block of text.split(/\n\s*\n/)) {
      if (block.trim()) blocks.push(block);
    }
  }

  for (const block of blocks) {
    if (looksLikePortalHelp(block)) {
      portalHelp.push(block.trim());
      continue;
    }
    for (const line of block.split("\n")) {
      if (!line.trim()) continue;
      // A single help line inside an otherwise ordinary block.
      if (looksLikePortalHelp(line)) {
        portalHelp.push(line.trim());
        continue;
      }
      const parsed = splitLabel(line);
      const rule = parsed ? LABEL_RULES.find((r) => r.test.test(parsed.label)) : undefined;
      if (!parsed || !rule) {
        // The bullet marker is a list artifact, not content — the words are
        // what must survive, and the section it lands in renders as prose.
        leftoverLines.push(stripBullet(line) || line.trimEnd());
        continue;
      }
      const value = rule.wholeLine ? stripBullet(line) : parsed.value.replace(/\.$/, "");
      if (rule.sectionId === "rules" && rule.key === "quietFrom") {
        const range = parseQuietHours(value);
        if (range) {
          // One row in the review, reading the way the manager wrote it, not
          // two rows of 24-hour times they have to decode.
          record("rules", "quietFrom", range.from, {
            displayValue: `${formatTimeLabel(range.from)} – ${formatTimeLabel(range.to)}`,
          });
          record("rules", "quietTo", range.to, { silent: true });
          // "10:00 PM - 8:00 AM daily. No loud music…" is a range AND a
          // sentence. Taking the times and binning the sentence is exactly the
          // silent loss this migration promises not to do, so whatever is left
          // of the line is kept, labelled, under "Anything else".
          const residual = value
            .replace(TIME_RANGE, "")
            .replace(/^[\s.,;:—–-]+/, "")
            .trim();
          if (residual) leftoverLines.push(`${parsed.label}: ${residual}`);
          continue;
        }
        // Unparseable hours are still a rule — keep the sentence rather than
        // dropping it on the floor because the format was unexpected.
        leftoverLines.push(stripBullet(line) || line.trimEnd());
        continue;
      }
      if (!record(rule.sectionId, rule.key, value)) leftoverLines.push(stripBullet(line) || line.trimEnd());
    }
  }

  // "Quiet hours" is recorded under two keys; the review list should name it once.
  const seen = new Set<string>();
  const dedupedMatches = matched.filter((m) => {
    const id = `${m.sectionId}.${m.label}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const leftover = leftoverLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (leftover) info = { ...info, other: leftover };

  return { info, matched: dedupedMatches, portalHelp, leftover };
}

/** Would the split actually find anything? Drives the "we found details" banner. */
export function legacyHouseTextHasSplittableContent(input: {
  generalHouseInfo?: string | null;
  houseRulesText?: string | null;
  wifiNetworkName?: string | null;
  wifiPassword?: string | null;
}): boolean {
  return parseLegacyHouseText(input).matched.length > 0;
}
