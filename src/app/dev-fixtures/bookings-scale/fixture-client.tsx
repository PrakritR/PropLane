"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BookingsPortfolioTimeline } from "@/components/portal/bookings-portfolio-timeline";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { addDaysToDateKey } from "@/lib/channel-calendar/bookings-ui";
import { dateKey } from "@/lib/room-availability-calendar";
import type { OccupancyCapacities } from "@/lib/occupancy/snapshot";

const HOUSES = 100;
const ROOMS = 10;
const STREETS = ["8th Ave NE", "Roosevelt Way", "Brooklyn Ave", "University Way", "15th Ave E", "Stone Way N", "Latona Ave", "Ravenna Blvd"];
const FIRST = ["Maya", "Jordan", "Priya", "Daniel", "Sofia", "Marcus", "Aiko", "Liam", "Noor", "Elena", "Tomas", "Hana", "Chris", "Imani", "Oskar"];
const LAST = ["Chen", "Smith", "Shah", "Reyes", "Alvarez", "Okafor", "Tanaka", "Murphy", "Haddad", "Rossi", "Novak", "Kim", "Park", "Diaz", "Berg"];

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const houseId = (index: number) => `fx-house-${String(index + 1).padStart(3, "0")}`;
const roomId = (index: number) => `room-${index + 1}`;
const houseName = (index: number) => `${4700 + index * 7} ${STREETS[index % STREETS.length]}`;

export function buildFixtureEntries(todayKey: string): PropertyBookingEntry[] {
  const random = rng(1018);
  const pick = <T,>(list: T[]) => list[Math.floor(random() * list.length)]!;
  const entries: PropertyBookingEntry[] = [];
  for (let h = 0; h < HOUSES; h++) {
    for (let r = 0; r < ROOMS; r++) {
      let cursor = addDaysToDateKey(todayKey, -30 + Math.floor(random() * 40));
      const horizon = addDaysToDateKey(todayKey, 45);
      while (cursor < horizon) {
        const roll = random();
        const guest = `${pick(FIRST)} ${pick(LAST)}`;
        const base = { propertyId: houseId(h), propertyLabel: houseName(h), roomId: roomId(r), roomLabel: `Room ${r + 1} · ${r < 5 ? "2nd" : "3rd"} floor` };
        let nights: number;
        let entry: PropertyBookingEntry;
        if (roll < 0.58) {
          nights = 28 + Math.floor(random() * 60);
          entry = { ...base, source: random() < 0.5 ? "proplane" : "hold", residentName: guest, summary: guest, start: cursor, end: addDaysToDateKey(cursor, nights - 1), bookingStatus: "confirmed", monthlyRent: 1000 } as PropertyBookingEntry;
        } else if (roll < 0.76) {
          nights = 1 + Math.floor(random() * 3);
          entry = { ...base, source: "airbnb", guestName: guest, summary: guest, start: cursor, end: addDaysToDateKey(cursor, nights - 1) } as PropertyBookingEntry;
        } else if (roll < 0.88) {
          nights = 1 + Math.floor(random() * 3);
          entry = { ...base, source: "proplane", residentName: guest, summary: guest, start: cursor, end: addDaysToDateKey(cursor, nights - 1), bookingStatus: "confirmed" } as PropertyBookingEntry;
        } else if (roll < 0.94) {
          nights = 2 + Math.floor(random() * 4);
          entry = { ...base, source: "block", residentName: guest, summary: guest, bookingStatus: "hold", start: cursor, end: addDaysToDateKey(cursor, nights - 1), blockId: `fx-hold-${h}-${r}-${cursor}` } as PropertyBookingEntry;
        } else {
          nights = 3 + Math.floor(random() * 5);
          entry = { ...base, source: "block", blockKind: "closed", reason: "Painting", summary: "Painting", start: cursor, end: addDaysToDateKey(cursor, nights - 1), blockId: `fx-block-${h}-${r}-${cursor}` } as PropertyBookingEntry;
        }
        entries.push(entry);
        cursor = addDaysToDateKey(cursor, nights + (random() < 0.45 ? Math.floor(random() * 25) : Math.floor(random() * 3)));
      }
    }
  }
  // One deliberate overlap: the first house's Room 1 is double-booked for a week.
  entries.push({ propertyId: houseId(0), propertyLabel: houseName(0), roomId: roomId(0), roomLabel: "Room 1 · 2nd floor", source: "airbnb", guestName: "Overlap Guest", summary: "Overlap Guest", start: addDaysToDateKey(todayKey, 2), end: addDaysToDateKey(todayKey, 9) } as PropertyBookingEntry);
  entries.push({ propertyId: houseId(0), propertyLabel: houseName(0), roomId: roomId(0), roomLabel: "Room 1 · 2nd floor", source: "proplane", residentName: "Resident Overlap", summary: "Resident Overlap", start: addDaysToDateKey(todayKey, 1), end: addDaysToDateKey(todayKey, 12), bookingStatus: "confirmed" } as PropertyBookingEntry);
  return entries;
}

const CAPACITIES: OccupancyCapacities = { bedsTotal: () => ROOMS, roomCapacity: () => 1 };

export function BookingsScaleFixture() {
  const today = useMemo(() => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), now.getDate()); }, []);
  const entries = useMemo(() => buildFixtureEntries(dateKey(today)), [today]);
  const propertyIds = useMemo(() => Array.from({ length: HOUSES }, (_, index) => houseId(index)), []);
  const [query, setQuery] = useState("");
  const mainRef = useRef<HTMLElement | null>(null);
  // The portal marks its light surface (where --card turns translucent); in dark it does not.
  useEffect(() => { if (document.documentElement.dataset.theme !== "dark") mainRef.current?.setAttribute("data-surface", "light"); }, []);
  const resolveRooms = useMemo(() => () => Array.from({ length: ROOMS }, (__, index) => ({ id: roomId(index), label: `Room ${index + 1} · ${index < 5 ? "2nd" : "3rd"} floor`, rent: "$1,000/mo" })), []);
  const resolveHouse = useMemo(() => (propertyId: string) => { const index = Number(propertyId.slice(-3)) - 1; return { name: houseName(index), address: `${houseName(index)}, Seattle WA` }; }, []);
  return <main ref={mainRef} className="mx-auto max-w-[1400px] p-3 sm:p-4">
    <input data-attr="fixture-search" aria-label="Search bookings" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search bookings" className="mb-3 h-11 w-full rounded-full border border-border bg-card px-4 text-sm" />
    <BookingsPortfolioTimeline propertyIds={propertyIds} entries={entries} today={today} searchQuery={query} preferenceKey="fixture" resolveRooms={resolveRooms} resolveHouse={resolveHouse} capacities={CAPACITIES} onEditBooking={() => {}} onUnblockBooking={() => {}} onDeleteBlock={() => {}} onReserveRoomDay={() => {}} onOpenDay={() => {}} />
  </main>;
}
