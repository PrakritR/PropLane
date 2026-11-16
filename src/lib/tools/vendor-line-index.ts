/**
 * The vendor-on-the-PropLane-line registry: TWO read tools, `list_open_jobs_near` and `list_open_gigs_near` (the priced PropLane Jobs among them), and no write. A stranger asking
 * "any jobs near me?" can be shown the public view of open work; nothing here books, bids, texts or changes a record.
 */
import { buildRegistry, type ToolRegistry } from "./registry";
import type { VendorLineContext } from "./vendor-line-context";
import { listOpenGigsNearTool, listOpenJobsNearTool } from "./domains/vendor-line";

export const vendorLineRegistry: ToolRegistry<VendorLineContext> = buildRegistry<VendorLineContext>([listOpenJobsNearTool, listOpenGigsNearTool]);
