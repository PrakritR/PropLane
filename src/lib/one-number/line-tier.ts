import type { MockProperty } from "@/data/types";

/**
 * Who answers for a home on the PropLane line. `managed` = PropLane's own (an `is_service` workspace), `free` = a
 * self-serve manager who texts from the 206, `paid` = a self-serve manager with a personal work number of their own (the
 * line never answers for them: a prospect who wants their home is given their number).
 */
export type LineTier = "managed" | "free" | "paid";

/** A public listing tagged with its tier. An untagged listing (a test fixture, per_workspace) reads as `managed`. */
export type LineListing = MockProperty & { lineTier?: LineTier };

export const lineTierOf = (listing: Pick<LineListing, "lineTier">): LineTier => listing.lineTier ?? "managed";
