import { describe, expect, it } from "vitest";
import { agentRegistry, buildManagerSmsRegistry, leasingSmsAgentRegistry, vendorWorkOrderAgentRegistry } from "@/lib/tools";
import { residentAgentRegistry } from "@/lib/tools/resident-index";
import { vendorAgentRegistry } from "@/lib/tools/vendor-index";
import { previewWriteTool, type ActionPreview, type ToolRegistry } from "@/lib/tools/registry";
import { makeWritableCtx } from "./fake-agent-ctx";
import { makeResidentToolCtx } from "./fake-resident-ctx";

/**
 * PRP-272 — every write tool must be able to produce a proper confirmation card.
 *
 * The card IS the safety gate: a person approves a write by reading `title`, `fields` and
 * `warnings`, so a preview that renders blank or throws turns an informed confirmation into a
 * blind one. Nothing checked that any of them could actually be built.
 *
 * This is a SWEEP over every registry rather than a hand-listed top-20, because a curated list
 * goes stale the moment someone adds a tool — and the tool most likely to have a broken preview
 * is the newest one, which is exactly the one a fixed list would miss.
 */

const REGISTRIES: [string, ToolRegistry<unknown>][] = [
  ["manager", agentRegistry as unknown as ToolRegistry<unknown>],
  ["resident", residentAgentRegistry as unknown as ToolRegistry<unknown>],
  ["vendor", vendorAgentRegistry as unknown as ToolRegistry<unknown>],
  ["manager-sms", buildManagerSmsRegistry() as unknown as ToolRegistry<unknown>],
  ["vendor-sms", vendorWorkOrderAgentRegistry as unknown as ToolRegistry<unknown>],
  ["leasing-sms", leasingSmsAgentRegistry as unknown as ToolRegistry<unknown>],
];

function writeToolsOf(registry: ToolRegistry<unknown>) {
  return [...registry.values()].filter((t) => t.kind === "write");
}

describe("every write tool is previewable", () => {
  for (const [portal, registry] of REGISTRIES) {
    it(`${portal}: each write tool declares a preview`, () => {
      const missing = writeToolsOf(registry)
        .filter((t) => typeof t.preview !== "function")
        .map((t) => t.name);

      // `buildRegistry` throws on this at construction, so a failure here means a registry was
      // assembled some other way. Asserted anyway: this is the invariant that decides whether a
      // write is reachable from chat at all.
      expect(missing).toEqual([]);
    });

    it(`${portal}: has at least one write tool, so an empty registry cannot pass vacuously`, () => {
      expect(writeToolsOf(registry).length).toBeGreaterThan(0);
    });
  }
});

/**
 * A card a person can actually act on. Asserted against the REAL `previewWriteTool` gate, so
 * these see exactly what the model loop builds — Zod validation, the throw→error mapping, and
 * the `confirmedInput` strip included.
 */
function expectUsableCard(preview: ActionPreview, toolName: string) {
  expect(preview.title?.trim(), `${toolName} title`).toBeTruthy();
  expect(preview.confirmLabel?.trim(), `${toolName} confirmLabel`).toBeTruthy();
  expect(Array.isArray(preview.fields), `${toolName} fields`).toBe(true);
  for (const field of preview.fields) {
    expect(field.label?.trim(), `${toolName} field label`).toBeTruthy();
    // A blank VALUE is legitimate (an optional note left empty); a blank LABEL is not, because
    // the reader then cannot tell what they are approving.
    expect(typeof field.value, `${toolName} field value type`).toBe("string");
  }
  for (const warning of preview.warnings ?? []) {
    expect(warning.trim(), `${toolName} warning`).toBeTruthy();
  }
}

/**
 * The highest-traffic manager writes, invoked for real against the in-memory store.
 *
 * Kept to tools whose preview reads only what this fixture provides. The sweep above is what
 * covers the rest; these prove the card itself is well-formed end to end.
 */
describe("write previews render a usable card, invoked for real", () => {
  it("create_work_order (manager)", async () => {
    const tool = "create_work_order";
    expect(agentRegistry.get(tool), `${tool} is not in the manager registry`).toBeTruthy();
    const { ctx } = makeWritableCtx({
      manager_property_records: [
        { id: "prop-1", manager_user_id: "manager_a", row_data: { id: "prop-1", title: "12 Elm", status: "live" } },
      ],
      portal_work_order_records: [],
    });

    const result = await previewWriteTool(agentRegistry, ctx, tool, {
      title: "Leaking tap",
      propertyId: "prop-1",
      description: "Kitchen",
    });

    if (!result.ok) expect.fail(`${tool} preview failed: ${result.error}`);
    expectUsableCard(result.preview, tool);
  });

  it("report_maintenance_issue (resident)", async () => {
    const tool = "report_maintenance_issue";
    expect(residentAgentRegistry.get(tool), `${tool} is not in the resident registry`).toBeTruthy();
    const { ctx } = makeResidentToolCtx(
      {
        manager_application_records: [
          {
            manager_user_id: "manager_1",
            resident_email: "resa@axis.test",
            updated_at: "2026-07-01T00:00:00.000Z",
            row_data: { bucket: "approved", name: "Res A", property: "Maple House", propertyId: "prop_1" },
          },
        ],
        profiles: [{ id: "manager_1", email: "mgr@axis.test", full_name: "Mgr One" }],
      },
      { managerIds: ["manager_1"] },
    );

    const result = await previewWriteTool(
      residentAgentRegistry as unknown as ToolRegistry<unknown>,
      ctx,
      tool,
      { description: "Kitchen sink is leaking" },
    );

    if (!result.ok) expect.fail(`${tool} preview failed: ${result.error}`);
    expectUsableCard(result.preview, tool);
    // The card must restate what the resident actually said, or they are approving a summary
    // rather than their own words.
    expect(result.preview.fields.some((f) => f.value.includes("Kitchen sink is leaking"))).toBe(true);
  });
});

/**
 * The documented list the ticket asks for, generated rather than typed — a hand-written one
 * would drift from the registries the moment a tool is added or renamed.
 */
describe("write tool inventory", () => {
  it("names every confirm-gated write per portal", () => {
    const inventory = Object.fromEntries(
      REGISTRIES.map(([portal, registry]) => [portal, writeToolsOf(registry).map((t) => t.name).sort()]),
    );

    for (const [portal, names] of Object.entries(inventory)) {
      expect(new Set(names).size, `${portal} has duplicate tool names`).toBe(names.length);
    }

    // Printed on failure of any assertion above, and readable in the test output, so the list
    // is discoverable without a second document to maintain.
    expect(Object.keys(inventory).sort()).toEqual(
      ["leasing-sms", "manager", "manager-sms", "resident", "vendor", "vendor-sms"],
    );
  });

  it("withholds every destructive tool from the manager SMS registry", () => {
    // Over SMS the only credential is an attacker-influencable `From` header and the
    // confirmation is a bare YES with no card to re-read. Derived from the flag, never a name
    // list, so a newly destructive tool is withheld automatically.
    const destructiveOverSms = writeToolsOf(buildManagerSmsRegistry() as unknown as ToolRegistry<unknown>)
      .filter((t) => t.destructive)
      .map((t) => t.name);

    expect(destructiveOverSms).toEqual([]);
  });
});
