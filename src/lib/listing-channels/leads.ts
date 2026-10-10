/** One lead that arrived through a listing site's tagged link. Pure and client-safe; the read is `leads.server.ts`. */
export type ListingSiteLead = {
  kind: "tour" | "application";
  /** The tour inquiry id / the application id: what the record page's URL carries. */
  id: string;
  propertyId: string;
  /** Exactly what the Tours / Applications lists already show a manager: a name, else the email, else a placeholder. */
  name: string;
  /** When the lead matters: the tour's start, or the application's last update. ISO, or null. */
  at: string | null;
  /** The list bucket the record sits in (`pending` / `upcoming` / `past` for a tour; `pending` / `approved` / `rejected` for an application). */
  bucket: string;
};
