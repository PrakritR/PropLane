#!/usr/bin/env bash
# UserPromptSubmit hook — keeps the captain's plan-first standing order in front
# of the agent on every prompt, and makes the studio watch unmissable while a
# plan is open.
#
# Hook-injected context is the highest-priority channel the agent sees, so this
# has to name the SAME pipeline the docs and .cursor rules do: the PropLane
# studio lane plan (lane workflow v2). The retired Lavish flow it used to
# advertise (`workflow:plan` / `lavish:listen` / `lavish:poll`) must not
# reappear here — two mandatory plan pipelines is the bug.
#
# Wire it up in ~/.claude/settings.json (see docs/agents/lavish-plan-standard.md):
#
#   "UserPromptSubmit": [{ "matcher": "", "hooks": [{ "type": "command",
#     "command": "bash \"$CLAUDE_PROJECT_DIR/scripts/hooks/lavish-plan-reminder.sh\"",
#     "timeout": 5 }]}]
#
# Silent outside PropLane, so it is safe in global settings.

set -u
root="${CLAUDE_PROJECT_DIR:-$PWD}"
case "$root" in
  *proplane*|*axis-2*|*AXIS-2*) ;;
  *) exit 0 ;;
esac

kit="${PROPLANE_PLAN_ROOT:-$HOME/proplane-mock-kit}"
lane="$(git -C "$root" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"

if [ -n "$lane" ] && [ -f "$kit/studio/plans/$lane/active.json" ]; then
  msg="STUDIO PLAN OPEN on lane \`$lane\`. Confirm \`node $kit/tools/studio-inbox.mjs --lane $lane --wait\` is running as a tracked background task BEFORE anything else this turn, apply the captain's feedback to the SAME plan.html, reply inside the studio, and write NO product code until \`node $kit/tools/studio-plan.mjs status --lane $lane\` exits 0 (status approved / built / skipped)."
else
  msg="PLAN FIRST: if this message describes work, write this lane's plan in the PropLane studio (\`node $kit/tools/studio-plan.mjs new --lane <lane> --id <id> --title \\\"<title>\\\"\`), fill it — the UI tab must MOCK the screen, before/after + desktop/mobile — start \`node $kit/tools/studio-inbox.mjs --lane <lane> --wait\` as a tracked background task, and stop until the plan is approved (or he types \`build\`). Do NOT file a Linear ticket for an issue unless he asks. Standard: docs/agents/lavish-plan-standard.md."
fi

printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"%s"}}\n' "$msg"
