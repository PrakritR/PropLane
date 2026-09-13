import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import McpDocsPage from "@/app/(public)/docs/mcp/page";
import { mcpToolCatalog } from "@/lib/mcp/catalog";

describe("public MCP tool descriptions", () => {
  it("normalizes generated display punctuation, brand, and service vocabulary", () => {
    const html = renderToStaticMarkup(McpDocsPage());

    expect(html).not.toContain("\u2014");
    expect(html).not.toMatch(/\bAxis\b/);
    expect(html).not.toMatch(/\bwork[ -]?orders?\b/i);
    expect(html).toContain("PropLane inbox");
    expect(html).toContain("PropLane vendor portal account");
    expect(html).toContain("outside PropLane");
    expect(html).toContain("PropLane ID");
    expect(html).toContain("workspace - accepted account links plus legacy pro-relationship links - with name");
    expect(html).toContain("equipment rentals - the Services");
    expect(html).toContain("fees, other income - same bookkeeping");
    for (const tool of mcpToolCatalog()) expect(html).toContain(tool.name);
  });
});
