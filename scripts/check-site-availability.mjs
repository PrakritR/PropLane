#!/usr/bin/env node
/**
 * Read-only: compare every public room's SHOWN availability with the occupancy snapshot, and print mismatches.
 *
 *   node scripts/check-site-availability.mjs [baseUrl]        (default http://localhost:3000; env BASE_URL also works)
 *   node scripts/check-site-availability.mjs https://proplane.ai --json
 *
 * For each live listing from `GET <base>/api/property-records/public` (the catalog the /rent pages render) the script reads
 * the availability each room SHOWS (the room's saved `availability` label, which the page, the feeds and the share cards
 * start from) and the room's occupancy spans from `GET <base>/api/public/approved-room-occupancy` (the snapshot the listing
 * page itself computes its live label from), works out whether the room is free today (Pacific), and reports every room
 * where the two disagree. It never writes anything: only
 * GET requests, no credentials, no database access. Exit 0 = no mismatch, 1 = mismatches found, 2 = could not read.
 *
 * "Occupied" = at least `capacity` people on the day; the same rule `availabilityLabelFromPublicSpans` applies.
 */

const args = process.argv.slice(2);
const json = args.includes("--json");
const base = (args.find((arg) => /^https?:\/\//i.test(arg)) ?? process.env.BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");

function pacificToday() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function getJson(path) {
  const res = await fetch(`${base}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

/** Is the room full on `day` (YYYY-MM-DD)? Spans are inclusive start..end, `end` null = open-ended. */
function occupiedOn(spans, capacity, day) {
  let count = 0;
  for (const span of spans) {
    if (span.start <= day && (!span.end || day <= span.end)) count += Number(span.count ?? 1);
  }
  return count >= Math.max(1, Number(capacity) || 1);
}

/** "Unavailable ..." / "Unavailable (occupied)" read as occupied now; "Available ..." and an empty label as free now. */
function shownIsOccupied(label) {
  return /^\s*unavailable/i.test(label ?? "") || /^\s*(occupied|blocked)/i.test(label ?? "");
}

async function main() {
  const today = pacificToday();
  let listings;
  let occupancy;
  try {
    const catalog = await getJson("/api/property-records/public");
    listings = Array.isArray(catalog) ? catalog : (catalog.listings ?? []);
    const snapshot = await getJson("/api/public/approved-room-occupancy");
    occupancy = Array.isArray(snapshot) ? snapshot : (snapshot.rooms ?? []);
  } catch (error) {
    console.error(`Could not read ${base}: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  }
  const spansByRoom = new Map(occupancy.map((row) => [row.roomChoice, row.spans ?? []]));

  const mismatches = [];
  let checked = 0;
  for (const listing of listings) {
    const submission = listing.listingSubmission ?? listing;
    for (const room of submission.rooms ?? []) {
      const key = `${listing.id}::${room.id}`;
      const spans = spansByRoom.get(key);
      if (!spans) continue; // no snapshot row for this room: nothing to compare against
      checked += 1;
      const shown = String(room.availability ?? "");
      // A room whose own move-in date is still ahead is not free today, whatever the spans say.
      const notYet = typeof room.moveInAvailableDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(room.moveInAvailableDate) && room.moveInAvailableDate > today;
      const snapshotOccupied = notYet || occupiedOn(spans, room.occupancyCapacity, today);
      const showsOccupied = shownIsOccupied(shown);
      if (showsOccupied !== snapshotOccupied) {
        mismatches.push({
          listing: listing.title ?? listing.address ?? listing.id,
          room: room.name ?? room.id,
          shown: shown || "(blank)",
          snapshot: snapshotOccupied ? "occupied today" : "free today",
          roomKey: key,
        });
      }
    }
  }

  if (json) {
    console.log(JSON.stringify({ base, day: today, rooms: checked, mismatches }, null, 2));
  } else {
    console.log(`Checked ${checked} rooms on ${base} for ${today} (Pacific).`);
    if (mismatches.length === 0) console.log("No mismatches: every room's shown availability matches the occupancy snapshot.");
    for (const m of mismatches) console.log(`MISMATCH  ${m.listing} / ${m.room}: shown "${m.shown}", snapshot says ${m.snapshot}  [${m.roomKey}]`);
  }
  process.exit(mismatches.length ? 1 : 0);
}

// The exit code is the contract: anything unexpected (a malformed catalog row, a snapshot that is not a list)
// still reports "could not read", never a Node-chosen code from an unhandled rejection.
main().catch((error) => {
  console.error(`Could not read ${base}: ${error instanceof Error ? error.message : error}`);
  process.exit(2);
});
