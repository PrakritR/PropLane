import { describe, expect, it } from "vitest";
import { DEFAULT_HOUSEMATE_SHARING, housemateSharingSchema, parseHousemateSharing, sharedHousemateDetails } from "@/lib/resident-housemate-sharing";

const person = { name: "Private Person", roomLabel: "Room 9", email: "private@example.test", phone: "555-0100" };
describe("housemate disclosure is opt-in", () => {
  it.each([undefined, null, {}, { shareName: "true" }])("hides all personal details for unset or invalid preferences", value => {
    expect(parseHousemateSharing(value)).toEqual(DEFAULT_HOUSEMATE_SHARING);
    expect(sharedHousemateDetails(person, value)).toEqual({ name: "Housemate", roomLabel: "", email: "", phone: null });
  });
  it.each(Array.from({ length: 16 }, (_, i) => i))("discloses only selected fields (%s)", mask => {
    const preferences = { shareName: !!(mask & 1), shareRoom: !!(mask & 2), shareEmail: !!(mask & 4), sharePhone: !!(mask & 8) };
    expect(sharedHousemateDetails(person, preferences)).toEqual({ name: mask & 1 ? person.name : "Housemate", roomLabel: mask & 2 ? person.roomLabel : "", email: mask & 4 ? person.email : "", phone: mask & 8 ? person.phone : null });
  });
  it("does not accept a caller-supplied identity or profile data", () => {
    expect(() => housemateSharingSchema.parse({ ...DEFAULT_HOUSEMATE_SHARING, user_id: "another-resident" })).toThrow();
    expect(() => housemateSharingSchema.parse({ ...DEFAULT_HOUSEMATE_SHARING, email: "another@example.test" })).toThrow();
  });
});
