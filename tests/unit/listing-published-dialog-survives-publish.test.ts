/**
 * PRP-496: the publish confirmation could never appear on the draft → live
 * path.
 *
 * `publishManagerPropertyDraftToServer` drops the row from the drafts bucket
 * and re-syncs before it resolves, so by the time the wizard reports back the
 * local mirror has already moved the record. The `onUpdated()` that follows
 * re-reads the routed entry: on the Drafts stage it is gone (the parent
 * early-returns "Loading this property…"), and on the All stage the row key
 * changes the moment publishing assigns a listingId. Either way the component
 * that HELD the dialog state unmounted or remounted, and the freshly-set state
 * went with it.
 *
 * The fix is ownership: the dialog lives in the exported panel, above that
 * boundary, and the row-detail component only reports the id and the name it
 * captured before the publish. These assertions pin that split.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const panel = readFileSync(
  path.join(process.cwd(), "src/components/portal/pro-house-properties-panel.tsx"),
  "utf8",
);

const section = (from: string, to: string) => {
  const start = panel.indexOf(from);
  expect(start, `${from} should exist`).toBeGreaterThan(-1);
  const end = panel.indexOf(to, start);
  expect(end, `${to} should follow ${from}`).toBeGreaterThan(start);
  return panel.slice(start, end);
};

const inlineDetails = () => section("function ManagerPropertyInlineDetails(", "type ManagerHousePropertiesPanelProps");
const exportedPanel = () =>
  section("export function ManagerHousePropertiesPanel(", "function ManagerHousePropertiesPanelBody(");

describe("the publish confirmation outlives the row it was published from", () => {
  it("the exported panel owns the dialog state and renders the dialog", () => {
    const wrapper = exportedPanel();
    expect(wrapper).toContain("useState<{ id: string; name: string } | null>(null)");
    expect(wrapper).toContain("<ListingPublishedDialog");
    expect(wrapper).toContain("publishedListing !== null");
  });

  it("renders the body as a SIBLING of the dialog, so a remount cannot take it down", () => {
    const wrapper = exportedPanel();
    const body = wrapper.indexOf("<ManagerHousePropertiesPanelBody");
    const dialog = wrapper.indexOf("<ListingPublishedDialog");
    expect(body).toBeGreaterThan(-1);
    expect(dialog).toBeGreaterThan(body);
    expect(wrapper).toContain("onPublishedListing={setPublishedListing}");
  });

  it("the row detail holds no dialog state of its own — it reports upward", () => {
    const details = inlineDetails();
    expect(details).not.toContain("setPublishedListing");
    expect(details).not.toContain("<ListingPublishedDialog");
    expect(details).toContain("onPublishedListing({ id: published, name: publishedName })");
  });

  it("captures the display name BEFORE onUpdated can move the row out of this stage", () => {
    const handler = panel.split("onPublished: (listingId?: string) => {")[1]?.slice(0, 900) ?? "";
    const captured = handler.indexOf("const publishedName = propertyShareLabel;");
    const updated = handler.indexOf("onUpdated();");
    expect(captured).toBeGreaterThan(-1);
    expect(updated).toBeGreaterThan(captured);
  });
});
