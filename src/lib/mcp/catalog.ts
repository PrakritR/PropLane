/**
 * The public tool catalog, derived from the live registry.
 *
 * The docs page renders THIS rather than a hand-written list. Typing ~96 tool
 * names into a marketing page is the same drift failure the generated guide art
 * exists to avoid: a tool added tomorrow documents itself, and a tool renamed
 * tomorrow cannot leave a lie behind on /docs/mcp.
 */
import { agentRegistry } from "@/lib/tools";

export type CatalogTool = {
  name: string;
  description: string;
  kind: "read" | "write";
};

/** Every tool an API key can reach, reads first, alphabetical within each kind. */
export function mcpToolCatalog(): CatalogTool[] {
  const tools: CatalogTool[] = [];
  for (const tool of agentRegistry.values()) {
    tools.push({
      name: tool.name,
      description: tool.description,
      kind: tool.kind === "write" ? "write" : "read",
    });
  }
  return tools.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "read" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function mcpToolCounts(): { read: number; write: number; total: number } {
  const tools = mcpToolCatalog();
  const read = tools.filter((t) => t.kind === "read").length;
  return { read, write: tools.length - read, total: tools.length };
}
