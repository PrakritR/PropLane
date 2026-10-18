import { completeAgentModel } from "@/lib/agent/provider";
import type { AnthropicToolSchema } from "@/lib/tools/registry";
import { NextResponse } from "next/server";
import type Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import { TIER_MODELS, selectLunaTaskModel, hasAgentModelCredential } from "@/lib/agent/model";
import { track } from "@/lib/analytics/posthog";
import { tracePublicToolTurn } from "@/lib/observability/langfuse";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import {
  buildHousingSearchSystemPrompt,
  catalogNeighborhoods,
  HOUSING_SEARCH_FILTERS_SCHEMA,
  loadPublicHousingCatalog,
  searchPublicHousing,
} from "@/lib/tools/domains/public-housing-search";
import { formatAgentChatUserError } from "@/lib/agent/assistant-turn-error";

export const runtime = "nodejs";

const TOOL_NAME = "search_public_housing";

/**
 * PUBLIC, UNAUTHENTICATED housing-search assistant for the resident "Find your
 * next home" search. Turns a natural-language request ("2 bed pet-friendly
 * under $2000 in Ballard, moving in August") into structured filters via one
 * forced tool call, then executes the SAME `searchPublicHousing` tool the UI
 * filters use — facts (listings, prices) are always tool-grounded, the model
 * only extracts intent, never invents a match. IP rate-limited like
 * `/api/agent/general-chat` since it is public and token-costing.
 */
export async function POST(req: Request) {
  const ip = clientIpFrom(req);
  if (!(await rateLimit(`housing-search:${ip}`, 12, 60_000)).ok) {
    return NextResponse.json(
      { error: "You're sending requests a little fast — please wait a moment and try again." },
      { status: 429 },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const message = typeof body.message === "string" ? body.message.trim().slice(0, 500) : "";
  const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim().slice(0, 100) : ip;
  if (!message) {
    return NextResponse.json({ error: "Describe what you're looking for." }, { status: 400 });
  }

  const selection = selectLunaTaskModel({ model: TIER_MODELS.simple, tier: "simple", provider: "anthropic", route: "anthropic", maxOutputTokens: 512 }, { maxOutputTokens: 4_000, timeoutMs: 20_000 });
  if (!hasAgentModelCredential(selection)) {
    return NextResponse.json({ error: "The assistant isn't configured in this environment." }, { status: 503 });
  }

  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  try {
    const result = await tracePublicToolTurn({
      name: "resident-housing-search",
      sessionId,
      input: message,
      run: async ({ llmCall, toolCall }) => {
        // One catalog read for the whole turn: the prompt's neighborhood list and the
        // search below share it, so an "Ask" never builds the uncached catalog twice.
        const catalog = await loadPublicHousingCatalog();
        const system = buildHousingSearchSystemPrompt({
          todayIso,
          neighborhoods: catalogNeighborhoods(catalog),
        });

        const tools = [
          {
            name: TOOL_NAME,
            description: "Structured filters extracted from the visitor's natural-language housing request.",
            input_schema: zodToJsonSchema(HOUSING_SEARCH_FILTERS_SCHEMA, { $refStrategy: "none" }) as Record<
              string,
              unknown
            >,
          },
        ];

        const messages: Anthropic.MessageParam[] = [{ role: "user", content: message }];
        const response = await completeAgentModel({
          selection,
          system,
          tools: tools as unknown as AnthropicToolSchema[],
          toolChoice: { type: "tool", name: TOOL_NAME },
          messages,
        });

        llmCall({
          model: response.responseModel ?? selection.model,
          usage: response.usage,
          input: messages,
          output: response.content,
        });

        const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
        if (toolUses.length !== 1 || toolUses[0]!.name !== TOOL_NAME) throw new Error("Housing search extraction did not return the required tool.");
        const parsed = HOUSING_SEARCH_FILTERS_SCHEMA.safeParse(toolUses[0]!.input);
        if (!parsed.success) throw new Error("Housing search extraction returned invalid filters.");
        const rawFilters = parsed.data;

        const searchResult = await searchPublicHousing(rawFilters, catalog);
        toolCall({ name: TOOL_NAME, input: rawFilters, output: { matchCount: searchResult.matches.length } });

        return searchResult;
      },
    });

    track("housing_search_chat_completed", sessionId, {
      matchCount: result.matches.length,
      bedroom: result.filters.bedroom ?? "any",
      bathroom: result.filters.bathroom ?? "any",
      hasBudget: typeof result.filters.maxBudget === "number" || typeof result.filters.minBudget === "number",
      leaseTypes: result.filters.leaseTypes?.join(",") ?? "any",
      hasNeighborhood: typeof result.filters.neighborhood === "string",
      petFriendly: result.filters.petFriendly === true,
    });

    return NextResponse.json({
      filters: result.filters,
      matchCount: result.matches.length,
      listings: result.matches.slice(0, 12).map((room) => ({
        key: room.key,
        propertyId: room.propertyId,
        headlineAddress: room.headlineAddress,
        neighborhood: room.neighborhood,
        priceLabel: room.priceLabel,
        bathroomHint: room.bathroomHint,
        availabilityLabel: room.availabilityLabel,
        petFriendly: room.petFriendly,
      })),
    });
  } catch (e) {
    console.error("[agent/housing-search] failed:", e);
    const { message, httpStatus } = formatAgentChatUserError(e);
    return NextResponse.json({ error: message }, { status: httpStatus });
  }
}
