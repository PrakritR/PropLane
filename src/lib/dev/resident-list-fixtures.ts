/** Dev-only placeholder rows when the manager has no resident directory entries yet. */
export type DevResidentListFixture = {
  id: string;
  name: string;
  email: string;
  propertyId: string;
  propertyLabel: string;
  roomLabel: string;
  groupId: string;
  signedMonthlyRent: number | null;
  leaseStart: string;
  leaseEnd: string;
  axisId: string;
  manuallyAdded: boolean;
  moveInInstructions?: string;
  manualResidentDetails?: undefined;
  isPrevious: boolean;
};

export const DEV_RESIDENT_LIST_FIXTURES: DevResidentListFixture[] = [
  {
    id: "fixture-resident-jordan-lee",
    name: "Jordan Lee",
    email: "jordan.lee@example.com",
    propertyId: "fixture-ballard-house",
    propertyLabel: "Ballard House",
    roomLabel: "Room 2",
    groupId: "",
    signedMonthlyRent: 98500,
    leaseStart: "2026-03-01",
    leaseEnd: "2027-02-28",
    axisId: "AXIS-FIX-001",
    manuallyAdded: true,
    isPrevious: false,
  },
  {
    id: "fixture-resident-jordan-lee-room-5",
    name: "Jordan Lee",
    email: "jordan.lee@example.com",
    propertyId: "fixture-ballard-house",
    propertyLabel: "Ballard House",
    roomLabel: "Room 5",
    groupId: "",
    signedMonthlyRent: 105000,
    leaseStart: "2026-05-01",
    leaseEnd: "2027-04-30",
    axisId: "AXIS-FIX-001B",
    manuallyAdded: false,
    isPrevious: false,
  },
  {
    id: "fixture-resident-sam-patel",
    name: "Sam Patel",
    email: "sam.patel@example.com",
    propertyId: "fixture-ballard-house",
    propertyLabel: "Ballard House",
    roomLabel: "Room 4",
    groupId: "",
    signedMonthlyRent: 102500,
    leaseStart: "2026-04-01",
    leaseEnd: "2027-03-31",
    axisId: "AXIS-FIX-002",
    manuallyAdded: true,
    isPrevious: false,
  },
  {
    id: "fixture-resident-morgan-kim",
    name: "Morgan Kim",
    email: "morgan.kim@example.com",
    propertyId: "fixture-pine-flats",
    propertyLabel: "Pine Flats 1",
    roomLabel: "Room 1",
    groupId: "AXISGRP-FIX01",
    signedMonthlyRent: 87500,
    leaseStart: "2026-02-15",
    leaseEnd: "2027-02-14",
    axisId: "AXIS-FIX-003",
    manuallyAdded: false,
    isPrevious: false,
  },
  {
    id: "fixture-resident-alex-rivera",
    name: "Alex Rivera",
    email: "alex.rivera@example.com",
    propertyId: "fixture-pine-flats",
    propertyLabel: "Pine Flats 1",
    roomLabel: "Room 3",
    groupId: "",
    signedMonthlyRent: 92500,
    leaseStart: "2026-01-01",
    leaseEnd: "2026-12-31",
    axisId: "AXIS-FIX-004",
    manuallyAdded: false,
    isPrevious: false,
  },
  {
    id: "fixture-resident-taylor-nguyen",
    name: "Taylor Nguyen",
    email: "taylor.nguyen@example.com",
    propertyId: "fixture-lakeview-studio",
    propertyLabel: "Lakeview Studio",
    roomLabel: "Studio A",
    groupId: "",
    signedMonthlyRent: 115000,
    leaseStart: "2025-11-01",
    leaseEnd: "2026-10-31",
    axisId: "AXIS-FIX-005",
    manuallyAdded: true,
    isPrevious: false,
  },
  {
    id: "fixture-resident-casey-brooks",
    name: "Casey Brooks",
    email: "casey.brooks@example.com",
    propertyId: "fixture-pine-flats",
    propertyLabel: "Pine Flats 1",
    roomLabel: "Room 2",
    groupId: "",
    signedMonthlyRent: 85000,
    leaseStart: "2024-06-01",
    leaseEnd: "2025-05-31",
    axisId: "AXIS-FIX-006",
    manuallyAdded: false,
    isPrevious: true,
  },
];

export function shouldShowDevResidentListFixtures(): boolean {
  return process.env.NODE_ENV === "development";
}
