import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The product has no "work orders" — a manager, resident or vendor reads
 * "service" everywhere. The DATA MODEL is unchanged and deliberately so:
 * `portal_work_order_records`, the `list_work_orders` tool, the
 * `work-order-*` modules and every comment describing them keep their names,
 * because renaming a tool is a model-facing contract change and renaming a
 * table is a migration. Only what a person reads changed.
 *
 * This scan is the guard on that split. It looks at rendered copy — quoted
 * strings and JSX text — and ignores identifiers, attributes and comments.
 */
function walk(dir: string, exts: string[]): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path, exts);
    return exts.some((ext) => path.endsWith(ext)) ? [path] : [];
  });
}

/** A line is exempt when the phrase there is an identifier, not copy. */
const EXEMPT = [
  "work_order",
  "workOrder",
  "WorkOrder",
  "work-order",
  "data-attr",
  "className",
  "import ",
  'from "',
];

/**
 * `manager-notification-preferences.ts` and `manager-scheduled-work-tasks.ts`
 * match TITLES ALREADY STORED on rows, which still carry the "Work order ·"
 * prefix written before the rename. Those literals are data, not copy.
 */
const STORED_TITLE_READERS = new Set([
  join("src", "lib", "manager-notification-preferences.ts"),
  join("src", "lib", "manager-scheduled-work-tasks.ts"),
]);

describe("user-visible copy", () => {
  it("never says work order", () => {
    const offenders: string[] = [];
    const files = [
      ...walk(join("src", "components"), [".tsx"]),
      ...walk(join("src", "app"), [".tsx"]),
    ];
    for (const file of files) {
      if (STORED_TITLE_READERS.has(file)) continue;
      for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
        if (EXEMPT.some((token) => line.includes(token))) continue;
        if (/work orders?/i.test(line)) offenders.push(`${file}:${index + 1} ${trimmed.slice(0, 100)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
