import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SERVICE_STAGE_IDS, SERVICE_STAGE_LABEL, SERVICE_STAGE_TABS, parseServiceStage } from "@/lib/service-lifecycle";

/**
 * One service vocabulary (src/lib/service-lifecycle.ts): every list says Open · Assigned · Scheduled ·
 * Completed, a vendor's answer is Requested · Estimate · Bid · Approved · Declined, and the manager's
 * actions are Request bids · Assign · Approve bid · Schedule · Complete · Pay. This scans the
 * user-visible string literals and JSX text of service / vendor / task UI for the retired words.
 */
const RETIRED = ["Vendor & schedule", "Mark done", "Compare quotes", "Potential", "Send quote", "Add quote"];

/** Files whose copy is the service / vendor / task UI. */
const UI_FILE = /(service|vendor|task|work-order|bid|calendar|booking)/i;

/**
 * Literals that are DATA, not copy: a stored value read back from a row, a legacy id kept so an old
 * link or record keeps resolving, a tool id the model-facing contract names. Each entry is
 * `file-suffix::literal`. Keep this list short and justified.
 */
const ALLOWED = new Set<string>([
  // Studio plan mobile-step-tabs-1004, Part 3: the add-on header's finishing step reads "Mark done". It is
  // defined once, here, and every other file imports the label; maintenance keeps "Complete".
  `${join("src", "lib", "service-header-next-step.ts")}::"Mark done"`,
]);

/**
 * Vendor-portal and task files still carrying a retired word. Their own branches (vendor portal /
 * tasks) rewrite that copy; once they land, delete the entry. A file listed here that no longer
 * has a hit costs nothing.
 */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(path) ? [path] : [];
  });
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

function copyHits(source: string, phrase: string): string[] {
  const code = stripComments(source);
  const hits: string[] = [];
  for (const m of code.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g)) {
    if (m[0].includes(phrase)) hits.push(m[0]);
  }
  for (const m of code.matchAll(/>([^<>{}\n]*)</g)) {
    if (m[1]!.includes(phrase)) hits.push(m[1]!.trim());
  }
  return hits;
}

describe("service vocabulary guard", () => {
  it("no retired word in service / vendor / task / calendar UI copy", () => {
    const files = [...walk(join("src", "components", "portal")), ...walk(join("src", "lib"))].filter((f) => UI_FILE.test(f));
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const phrase of RETIRED) {
        for (const hit of copyHits(source, phrase)) {
          if (ALLOWED.has(`${file}::${hit}`)) continue;
          offenders.push(`${file}: ${hit.slice(0, 90)}  [${phrase}]`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the guard itself sees a retired word in a literal and in JSX text", () => {
    expect(copyHits('const a = "Vendor & schedule";', "Vendor & schedule")).toHaveLength(1);
    expect(copyHits("<b>Mark done</b>", "Mark done")).toHaveLength(1);
    expect(copyHits("// Mark done is retired\nconst a = 1;", "Mark done")).toHaveLength(0);
  });
});

describe("service stages", () => {
  it("are the four words every list uses, in order", () => {
    expect(SERVICE_STAGE_TABS.map((t) => t.label)).toEqual(["Open", "Assigned", "Scheduled", "Completed"]);
    expect(SERVICE_STAGE_IDS.map((id) => SERVICE_STAGE_LABEL[id])).toEqual(["Open", "Assigned", "Scheduled", "Completed"]);
  });

  it("old tab ids resolve onto a stage and never fall off the lists", () => {
    expect(parseServiceStage("done")).toBe("completed");
    expect(parseServiceStage("completed")).toBe("completed");
    expect(parseServiceStage("pending")).toBe("open");
    expect(parseServiceStage("potential")).toBe("open");
    expect(parseServiceStage("active")).toBe("scheduled");
    expect(parseServiceStage("assigned")).toBe("assigned");
    expect(parseServiceStage("nonsense")).toBe("open");
  });
});
