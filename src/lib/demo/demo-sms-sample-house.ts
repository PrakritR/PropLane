/**
 * The sandbox house the text / web DEMO runs on: "61 Willow Court", 3 rooms, 2 fake residents.
 * Fixture only. Every name here is invented; nothing is ever read from or written to a real row.
 * (Kept apart from the retired /demo "Seattle Homes" portfolio, whose tests pin three properties.)
 */
export const DEMO_SAMPLE_HOUSE = {
  address: "61 Willow Court",
  city: "Seattle",
  rooms: [
    { id: "demo-willow-room-1", name: "Room 1", rent: 850, resident: "Maya" },
    { id: "demo-willow-room-2", name: "Room 2", rent: 875, resident: "Sam" },
    { id: "demo-willow-room-3", name: "Room 3", rent: 850, resident: null },
  ],
  applicant: { name: "Jordan", room: "Room 3", tourLabel: "Thu 5:00 pm" },
  vendor: { name: "Pat Plumbing", estimate: 120, slot: "Tue 10 to 12" },
  rentDueLabel: "Nov 1",
} as const;
