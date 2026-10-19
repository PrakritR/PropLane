/**
 * The arrival guide and the checkout reminder a short-stay guest is texted
 * (bookings-times-1018).
 *
 * Pure and framework-free. Built ONLY from the property's own `houseInfo`
 * (`src/lib/house-info.ts`) and the stay's resolved check-in / check-out time:
 * a fact the manager never entered is simply left out, nothing is invented.
 *
 * SECURITY: the door code, gate code and Wi-Fi password are in the text this
 * returns. It is addressed to ONE guest, in their own 1:1 thread with the
 * manager, and nowhere else: never a group, never a prospect, never a public
 * projection. The caller (`subjects/stay-times.server.ts`) builds it at send
 * time and never stores it in a reminder payload.
 *
 * Length: kept within `ARRIVAL_GUIDE_MAX_SEGMENTS` billed text segments. When
 * the house has more to say than fits, optional sections drop first (greeting,
 * extra rules, access notes, house rules, parking, Wi-Fi). The check-in time,
 * the entry codes and the link to the guest's Stays page never drop.
 */
import { getHouseInfoValue, type HouseInfoV1 } from "@/lib/house-info";
import { formatStayTime, normalizeStayTime } from "@/lib/bookings/stay-times";
import { smsSegmentCount, toGsm7 } from "@/lib/one-number/segments";

export const ARRIVAL_GUIDE_MAX_SEGMENTS = 4;

/** A text that carries only the essentials: at most this many characters. */
export const ARRIVAL_GUIDE_SMS_MAX_CHARS = 320;

export type ArrivalGuideStay = {
  /** Check-in date, YYYY-MM-DD. */
  checkIn: string;
  /** The stay's real check-in, "HH:MM" property wall time (the paid early time when bought). */
  checkInTime: string;
  /** The guest's own Stays page. */
  staysUrl?: string | null;
  guestName?: string | null;
  propertyLabel?: string | null;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthDay(dateKey: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey ?? "").trim());
  if (!match) return "";
  return `${MONTHS[Number(match[2]) - 1] ?? ""} ${Number(match[3])}`;
}

function firstName(name: string | null | undefined): string {
  return String(name ?? "").trim().split(/\s+/)[0] ?? "";
}

/** One fact line; descriptive text goes through GSM-7, codes and passwords are kept verbatim. */
function line(label: string, value: string, options: { verbatim?: boolean } = {}): string {
  const clean = options.verbatim ? value.trim() : toGsm7(value).replace(/\s*\n+\s*/g, " ");
  return clean ? `${label}: ${clean}` : "";
}

type GuideBlock = {
  /** Lower is kept longer. `0` is never dropped. */
  priority: number;
  lines: string[];
};

function guideBlocks(houseInfo: HouseInfoV1 | null | undefined, stay: ArrivalGuideStay): GuideBlock[] {
  const get = (section: Parameters<typeof getHouseInfoValue>[1], key: string) =>
    houseInfo ? getHouseInfoValue(houseInfo, section, key) : "";
  const time = normalizeStayTime(stay.checkInTime);
  const day = monthDay(stay.checkIn);
  const first = firstName(stay.guestName);
  const place = toGsm7(String(stay.propertyLabel ?? "").trim());
  const blocks: GuideBlock[] = [];

  blocks.push({
    priority: 9,
    lines: [first ? `Hi ${toGsm7(first)}, here is your arrival guide${place ? ` for ${place}` : ""}.` : `Here is your arrival guide${place ? ` for ${place}` : ""}.`],
  });
  if (time) {
    blocks.push({ priority: 0, lines: [`Check-in is at ${formatStayTime(time)}${day ? ` on ${day}` : ""}.`] });
  }
  blocks.push({
    priority: 0,
    lines: [
      line("Door code", get("access", "doorCode"), { verbatim: true }),
      line("Gate or building code", get("access", "gateCode"), { verbatim: true }),
      line("Key pickup", get("access", "keyPickup")),
    ].filter(Boolean),
  });
  const staysUrl = String(stay.staysUrl ?? "").trim();
  if (staysUrl) blocks.push({ priority: 3, lines: [`Your stay: ${staysUrl}`] });
  const network = get("wifi", "network");
  const password = get("wifi", "password");
  if (network || password) {
    blocks.push({
      priority: 4,
      lines: [
        [network ? `Wi-Fi: ${network}` : "Wi-Fi", password ? `password ${password}` : ""].filter(Boolean).join(", "),
      ],
    });
  }
  blocks.push({ priority: 5, lines: [line("Parking", get("access", "parking"))].filter(Boolean) });
  blocks.push({ priority: 7, lines: [line("Access notes", get("access", "notes"))].filter(Boolean) });

  const quietFrom = get("rules", "quietFrom");
  const quietTo = get("rules", "quietTo");
  const rulesCore = [
    quietFrom && quietTo ? `Quiet hours ${formatStayTime(normalizeStayTime(quietFrom) ?? quietFrom)} to ${formatStayTime(normalizeStayTime(quietTo) ?? quietTo)}` : "",
    get("rules", "smoking"),
    get("rules", "guests"),
    get("rules", "pets"),
  ]
    .map((value) => toGsm7(value))
    .filter(Boolean);
  if (rulesCore.length > 0) blocks.push({ priority: 6, lines: [`House rules: ${rulesCore.join("; ")}.`] });
  const rulesExtra = [get("rules", "kitchen"), get("rules", "bathroom"), get("rules", "commonAreas"), get("rules", "other")]
    .map((value) => toGsm7(value).replace(/\s*\n+\s*/g, " "))
    .filter(Boolean);
  if (rulesExtra.length > 0) blocks.push({ priority: 8, lines: [rulesExtra.join(" ")] });
  return blocks.filter((block) => block.lines.length > 0);
}

function composeBlocks(blocks: readonly GuideBlock[]): string {
  return blocks.map((block) => block.lines.join("\n")).join("\n");
}

/**
 * The arrival guide, built from the property's house details. Fits
 * `ARRIVAL_GUIDE_MAX_SEGMENTS` billed segments by dropping the least important
 * sections first; the check-in time, the entry codes and the Stays link stay.
 */
export function buildArrivalGuideText(
  houseInfo: HouseInfoV1 | null | undefined,
  stay: ArrivalGuideStay,
  options: { maxSegments?: number } = {},
): string {
  const maxSegments = options.maxSegments ?? ARRIVAL_GUIDE_MAX_SEGMENTS;
  let blocks = guideBlocks(houseInfo, stay);
  while (smsSegmentCount(composeBlocks(blocks)) > maxSegments) {
    const droppable = blocks.filter((block) => block.priority > 0);
    if (droppable.length === 0) break;
    const worst = droppable.reduce((a, b) => (b.priority >= a.priority ? b : a));
    blocks = blocks.filter((block) => block !== worst);
  }
  return composeBlocks(blocks);
}

/**
 * The text-message version: the check-in time, the entry codes and the link to
 * the full guide, nothing else, within `ARRIVAL_GUIDE_SMS_MAX_CHARS`. The inbox
 * thread and the email carry the whole guide.
 */
export function buildArrivalGuideSmsText(houseInfo: HouseInfoV1 | null | undefined, stay: ArrivalGuideStay): string {
  const blocks = guideBlocks(houseInfo, { ...stay, guestName: null, propertyLabel: null }).filter(
    (block) => block.priority <= 3,
  );
  let kept = blocks;
  while (composeBlocks(kept).length > ARRIVAL_GUIDE_SMS_MAX_CHARS) {
    const droppable = kept.filter((block) => block.priority > 0);
    if (droppable.length === 0) break;
    const worst = droppable.reduce((a, b) => (b.priority >= a.priority ? b : a));
    kept = kept.filter((block) => block !== worst);
  }
  return composeBlocks(kept);
}

export type CheckoutReminderStay = {
  /** The stay's real checkout, "HH:MM" (the paid late time when bought). */
  checkOutTime: string;
  staysUrl?: string | null;
  guestName?: string | null;
  propertyLabel?: string | null;
};

/** "Checkout is at 11:00 am today." plus the guest's Stays link. */
export function buildCheckoutReminderText(stay: CheckoutReminderStay): string {
  const time = normalizeStayTime(stay.checkOutTime);
  const first = firstName(stay.guestName);
  const place = toGsm7(String(stay.propertyLabel ?? "").trim());
  const staysUrl = String(stay.staysUrl ?? "").trim();
  return [
    first ? `Hi ${toGsm7(first)},` : "",
    time ? `Checkout is at ${formatStayTime(time)} today${place ? ` at ${place}` : ""}.` : `Checkout is today${place ? ` at ${place}` : ""}.`,
    staysUrl ? `Your stay: ${staysUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
