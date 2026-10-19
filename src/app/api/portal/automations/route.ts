import { NextResponse } from "next/server";
import { listAnnounceHouses } from "@/lib/automations/announce.server";
import {
  AUTOMATION_PRESETS,
  GROUP_FORBIDDEN_VARIABLES,
  VARIABLE_LABELS,
  isAutomationMode,
  isAutomationPresetId,
  getAutomationPreset,
  visibleAutomationPresets,
  effectiveAutomationMode,
} from "@/lib/automations/presets";
import { listHeldRuns, loadAutomationSettings, saveAutomationSetting } from "@/lib/automations/store.server";
import { validateTemplate } from "@/lib/automations/templates";
import { requireKnowledgeActor } from "@/lib/one-number/knowledge/route-auth.server";

export const runtime = "nodejs";

/** The workspace's automations: every visible preset with its mode and wording, plus the drafts waiting to send. */
export async function GET() {
  const auth = await requireKnowledgeActor("read");
  if (!auth.ok) return auth.response;
  const { actor } = auth;
  const saved = await loadAutomationSettings(actor.db, actor.workspaceId);
  const held = await listHeldRuns(actor.db, actor.workspaceId);
  const houses = await listAnnounceHouses(actor.db, {
    ownerUserId: actor.ownerUserId,
    workspaceId: actor.workspaceId,
    allowedPropertyIds: actor.allowedPropertyIds,
  });
  const visible = new Set(visibleAutomationPresets().map((p) => p.id));
  return NextResponse.json({
    canEdit: actor.isOwner,
    presets: AUTOMATION_PRESETS.filter((p) => visible.has(p.id)).map((preset) => {
      const row = saved.get(preset.id);
      return {
        id: preset.id,
        label: preset.label,
        audience: preset.audience,
        engine: preset.engine,
        hasOwnText: preset.hasOwnText,
        modes: preset.modes,
        mode: effectiveAutomationMode(preset, row?.mode),
        template: row?.template?.trim() || preset.template,
        isDefaultTemplate: !row?.template?.trim(),
        variables: preset.variables
          .filter((v) => !(preset.audience === "group" && GROUP_FORBIDDEN_VARIABLES.has(v)))
          .map((v) => ({ id: v, label: VARIABLE_LABELS[v] })),
      };
    }),
    held: held.filter((run) => {
      if (!actor.allowedPropertyIds) return true;
      return run.propertyId !== null && actor.allowedPropertyIds.includes(run.propertyId);
    }),
    houses,
  });
}

/** Body: `{ preset, mode?, template? }`. `template: null` returns to the default wording. Owner only. */
export async function PUT(req: Request) {
  const auth = await requireKnowledgeActor();
  if (!auth.ok) return auth.response;
  const { actor } = auth;
  if (!actor.isOwner) return NextResponse.json({ error: "Only the workspace owner can change automations." }, { status: 403 });
  let body: { preset?: unknown; mode?: unknown; template?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (!isAutomationPresetId(body.preset)) return NextResponse.json({ error: "Choose an automation." }, { status: 400 });
  const preset = getAutomationPreset(body.preset)!;
  const saved = await loadAutomationSettings(actor.db, actor.workspaceId);
  const current = effectiveAutomationMode(preset, saved.get(preset.id)?.mode);
  let mode = current;
  if (body.mode !== undefined) {
    if (!isAutomationMode(body.mode) || !preset.modes.includes(body.mode)) {
      return NextResponse.json({ error: "That mode is not available here." }, { status: 400 });
    }
    mode = body.mode;
  }
  let template: string | null | undefined;
  if (body.template === null) template = null;
  else if (typeof body.template === "string") {
    if (!preset.hasOwnText) return NextResponse.json({ error: "This one keeps its wording in Payments." }, { status: 400 });
    const check = validateTemplate(preset, body.template);
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
    template = body.template.trim() === preset.template ? null : body.template.trim();
  } else if (body.template !== undefined) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const ok = await saveAutomationSetting(actor.db, {
    workspaceId: actor.workspaceId,
    preset: preset.id,
    mode,
    template,
    userId: actor.userId,
  });
  return ok ? NextResponse.json({ preset: preset.id, mode }) : NextResponse.json({ error: "Could not save." }, { status: 503 });
}
