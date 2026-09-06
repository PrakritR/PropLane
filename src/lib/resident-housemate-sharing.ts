import { z } from "zod";

export const housemateSharingSchema = z.object({
  shareName: z.boolean(), shareRoom: z.boolean(), shareEmail: z.boolean(), sharePhone: z.boolean(),
}).strict();
export type HousemateSharing = z.infer<typeof housemateSharingSchema>;
export const DEFAULT_HOUSEMATE_SHARING: HousemateSharing = { shareName: false, shareRoom: false, shareEmail: false, sharePhone: false };
export const HOUSEMATE_SHARING_LABELS: Record<keyof HousemateSharing, string> = {
  shareName: "My name", shareRoom: "My room", shareEmail: "My email address", sharePhone: "My phone number",
};
export function parseHousemateSharing(value: unknown): HousemateSharing {
  const parsed = housemateSharingSchema.safeParse(value);
  return parsed.success ? parsed.data : { ...DEFAULT_HOUSEMATE_SHARING };
}
/** Remove unconsented values before serializing a housemate to a browser or assistant. */
export function sharedHousemateDetails(
  person: { name: string; email: string; phone: string | null; roomLabel: string },
  preferences: unknown,
) {
  const sharing = parseHousemateSharing(preferences);
  return {
    name: sharing.shareName ? person.name : "Housemate",
    roomLabel: sharing.shareRoom ? person.roomLabel : "",
    email: sharing.shareEmail ? person.email : "",
    phone: sharing.sharePhone ? person.phone : null,
  };
}
