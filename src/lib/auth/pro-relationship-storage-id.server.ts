import { createHash } from "node:crypto";

/** Physical keys are private to each writer; row_data.id remains the invite id. */
export function relationshipStorageId(userId: string, logicalId: string): string {
  return `relationship:v1:${createHash("sha256").update(JSON.stringify([userId, logicalId])).digest("hex")}`;
}
