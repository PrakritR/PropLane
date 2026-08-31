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

/**
 * Mirrors `manager@test` workflow seed ids (`tests/helpers/seed-test-db.mjs`) so
 * dev placeholders line up once applications sync. Run `npm run seed:dev` and sign
 * in as manager@test.proplane.local to load the full portal rows behind these ids.
 */
export const DEV_RESIDENT_LIST_FIXTURES: DevResidentListFixture[] = [
  {
    id: "AXIS-DEMOJORDL",
    name: "Jordan Lee",
    email: "jordan.lee.workflow@test.proplane.local",
    propertyId: "mgr-demo-pioneer",
    propertyLabel: "The Pioneer",
    roomLabel: "Room 12A",
    groupId: "",
    signedMonthlyRent: 110000,
    leaseStart: "2026-03-01",
    leaseEnd: "2027-02-28",
    axisId: "AXIS-DEMOJORDL",
    manuallyAdded: false,
    isPrevious: false,
  },
  {
    id: "AXIS-DEMOGRAP1",
    name: "Riley Group Lead",
    email: "riley.group.lead.workflow@test.proplane.local",
    propertyId: "mgr-demo-ballard",
    propertyLabel: "Ballard House",
    roomLabel: "Room 2",
    groupId: "PROPLANE-DEMOGRP2",
    signedMonthlyRent: null,
    leaseStart: "2026-04-01",
    leaseEnd: "2027-03-31",
    axisId: "AXIS-DEMOGRAP1",
    manuallyAdded: false,
    isPrevious: false,
  },
  {
    id: "AXIS-DEMOGRAP2",
    name: "Sam Group Mate",
    email: "sam.group.mate.workflow@test.proplane.local",
    propertyId: "mgr-demo-ballard",
    propertyLabel: "Ballard House",
    roomLabel: "Room 3",
    groupId: "PROPLANE-DEMOGRP2",
    signedMonthlyRent: null,
    leaseStart: "2026-04-01",
    leaseEnd: "2027-03-31",
    axisId: "AXIS-DEMOGRAP2",
    manuallyAdded: false,
    isPrevious: false,
  },
  {
    id: "AXIS-DEMOCOSAP",
    name: "Casey Cosigner Host",
    email: "casey.cosigner.host.workflow@test.proplane.local",
    propertyId: "mgr-demo-cascade",
    propertyLabel: "Cascade Lofts",
    roomLabel: "Room 1",
    groupId: "",
    signedMonthlyRent: null,
    leaseStart: "2026-05-01",
    leaseEnd: "2027-04-30",
    axisId: "AXIS-DEMOCOSAP",
    manuallyAdded: false,
    isPrevious: false,
  },
  {
    id: "AXIS-DEMOSOFID",
    name: "Sofia Diaz",
    email: "sofia.diaz.workflow@test.proplane.local",
    propertyId: "mgr-demo-ballard",
    propertyLabel: "Ballard House",
    roomLabel: "Room 1",
    groupId: "",
    signedMonthlyRent: null,
    leaseStart: "2026-03-15",
    leaseEnd: "2027-03-14",
    axisId: "AXIS-DEMOSOFID",
    manuallyAdded: false,
    isPrevious: false,
  },
  {
    id: "AXIS-DEMOCOSIN1",
    name: "Jordan With Cosigner",
    email: "jordan.cosigner.workflow@test.proplane.local",
    propertyId: "mgr-demo-cascade",
    propertyLabel: "Cascade Lofts",
    roomLabel: "Room 2",
    groupId: "",
    signedMonthlyRent: null,
    leaseStart: "",
    leaseEnd: "",
    axisId: "AXIS-DEMOCOSIN1",
    manuallyAdded: false,
    isPrevious: true,
  },
];

export function shouldShowDevResidentListFixtures(): boolean {
  return process.env.NODE_ENV === "development";
}
