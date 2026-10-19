/**
 * The vendor-on-the-PropLane-line registry: ONE read tool, `list_open_jobs_near`, and no write. A stranger asking
 * "any jobs near me?" can be shown the public view of open work; nothing here books, bids, texts or changes a record.
 */
import { buildRegistry, type ToolRegistry } from "./registry";
import type { VendorLineContext } from "./vendor-line-context";
import { listOpenJobsNearTool } from "./domains/vendor-line";

export const vendorLineRegistry: ToolRegistry<VendorLineContext> = buildRegistry<VendorLineContext>([listOpenJobsNearTool]);
