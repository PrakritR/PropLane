/** One lead that arrived through a listing site's tagged link. Pure and client-safe; the read is `leads.server.ts`. */
export type ListingSiteLead = {
  kind: "tour" | "application";
  /** The tour inquiry id / the application id. */
  id: string;
  /**
   * The id of the row this lead IS in its list, when one exists: an application's own id, a pending tour request's
   * window row, a declined request's row. Null for a confirmed tour, whose row is the planned event the inquiry no
   * longer names — such a lead opens its bucket's list.
   */
  rowId: string | null;
  propertyId: string;
  /** Exactly what the Tours / Applications lists already show a manager: a name, else the email, else a placeholder. */
  name: string;
  /** When the lead matters: the tour's start, or the application's last update. ISO, or null. */
  at: string | null;
  /** The bucket the row sits in, read from its own status (`pending` / `upcoming` / `past` for a tour; `pending` / `approved` / `rejected` for an application). */
  bucket: string;
};
