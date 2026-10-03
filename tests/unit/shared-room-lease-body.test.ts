// C2-SR11: when PropLane writes the lease body, the shared-room and roommate clauses are in it, and a
// joint lease names every roommate as a signer. Only a PDF's bytes stay untouched; the same terms
// arrive as a "Shared room addendum" there. Wording is the one structure in lease-shared-room-terms.ts
// — no statute is cited anywhere in it.
import { describe, expect, it } from "vitest";
import { snapshotJordanLee } from "@/data/manager-application-snapshots";
import { buildAiGeneratedLeaseHtml, leaseContextFromApplication, type LeaseGenerationContext } from "@/lib/generated-lease";
import { SHARED_ROOM_CLAUSES_MARKER, sharedRoomLeaseTerms, sharedRoomSigners } from "@/lib/lease-shared-room-terms";

const room = (over: Record<string, unknown> = {}) =>
  ({ id: "r8", name: "Room 8", monthlyRent: 1950, occupancyCapacity: 3, ...over }) as never;

function generated(ctx: LeaseGenerationContext): string {
  const out = buildAiGeneratedLeaseHtml(ctx);
  if (out.kind !== "generated") throw new Error(out.error);
  return out.html;
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("a generated lease body carries the shared-room clauses", () => {
  const base = leaseContextFromApplication(snapshotJordanLee());

  it("names the bed and rent, the roommate clauses, and lists every roommate as a signer on a joint lease", () => {
    const sharedRoom = sharedRoomLeaseTerms({
      room: room({ sharedRoomLeaseKind: "joint" }),
      propertyAddress: "123 Main St",
      residents: [
        { name: "Casey Morgan", slot: 1, rentOverride: 650 },
        { name: "Dana Lee", slot: 2, rentOverride: 650 },
        { name: "Priya Shah", slot: 3, rentOverride: 650 },
      ],
    })!;
    const html = generated({ ...base, sharedRoom });
    expect(count(html, SHARED_ROOM_CLAUSES_MARKER)).toBe(1);
    expect(html).toContain("Shared room terms");
    for (const title of ["Your space", "Rent", "Roommates on this lease", "Shared spaces and roommates", "If a roommate leaves"]) {
      expect(html).toContain(`<strong>${title}.</strong>`);
    }
    expect(html).toContain("Bed A in Room 8");
    expect(html).toContain("$650");
    // Every roommate is a signer in the document itself, beside the landlord.
    const signers = html.slice(html.indexOf('data-axis-shared-room-signers'));
    for (const name of ["Casey Morgan", "Dana Lee", "Priya Shah"]) expect(signers).toContain(name);
    expect(signers).toContain("Landlord / Authorized Agent");
    expect(count(signers.split("</ul>")[0]!, "<li>")).toBe(4);
  });

  it("a separate lease names only its own resident and prints no joint signers list", () => {
    const sharedRoom = sharedRoomLeaseTerms({
      room: room({ sharedRoomLeaseKind: "individual" }),
      propertyAddress: "123 Main St",
      residents: [{ name: "Casey Morgan", slot: 2 }, { name: "Dana Lee", slot: 1 }],
    })!;
    const html = generated({ ...base, sharedRoom });
    expect(html).toContain("<strong>Separate lease.</strong>");
    expect(html).not.toContain("data-axis-shared-room-signers");
    expect(html).not.toContain("Dana Lee");
  });

  it("an ordinary single-resident lease is unchanged", () => {
    expect(generated(base)).not.toContain(SHARED_ROOM_CLAUSES_MARKER);
  });

  it("never cites a statute in the shared-room wording", () => {
    const sharedRoom = sharedRoomLeaseTerms({ room: room({ sharedRoomLeaseKind: "joint" }), propertyAddress: "1 Main", residents: [{ name: "A", slot: 1 }, { name: "B", slot: 2 }] })!;
    const block = generated({ ...base, sharedRoom });
    const section = block.slice(block.indexOf(SHARED_ROOM_CLAUSES_MARKER));
    expect(section).not.toMatch(/RCW|U\.S\.C\.|Civ(il)?\.? Code|§|ordinance/i);
  });

  it("signers are the landlord then each resident, one list for tests and document", () => {
    const terms = sharedRoomLeaseTerms({ room: room({ sharedRoomLeaseKind: "joint" }), propertyAddress: "", residents: [{ name: "A", slot: 1 }, { name: "B", slot: 2 }] })!;
    expect(sharedRoomSigners(terms).map((s) => s.name)).toEqual(["", "A", "B"]);
  });
});

describe("on a manager's own document the same terms arrive once, as a Shared room addendum", () => {
  it("prints the addendum heading with the same clauses and no second copy", () => {
    const base = leaseContextFromApplication({ ...snapshotJordanLee(), managerRentOverride: "1250" });
    const sharedRoom = sharedRoomLeaseTerms({
      room: room({ sharedRoomLeaseKind: "joint" }),
      propertyAddress: "123 Main St",
      residents: [{ name: "Casey Morgan", slot: 1 }, { name: "Dana Lee", slot: 2 }],
    })!;
    const ctx: LeaseGenerationContext = {
      ...base,
      sharedRoom,
      submission: {
        ...(base.submission ?? { v: 1, rooms: [], bathrooms: [], sharedSpaces: [], bundles: [], quickFacts: [] }),
        propertyLeaseTemplates: [
          {
            id: "long-v1", kind: "long-term", label: "Long-term lease", listingSeedKey: "primary", leaseConfigMode: "custom", leaseCustomKind: "document",
            customLeaseTerms: "", leaseTemplateDocUrl: "/api/portal/lease-template?path=11111111-1111-1111-1111-111111111111/long.pdf", leaseTemplateDocName: "Long-term.pdf",
            createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
          },
        ],
      } as never,
    };
    const html = generated(ctx);
    expect(count(html, SHARED_ROOM_CLAUSES_MARKER)).toBe(1);
    expect(html).toContain("Shared room addendum");
    expect(html).not.toContain("Shared room terms");
    expect(html).toContain("Roommates on this lease");
    expect(html).toContain("Dana Lee");
  });
});
