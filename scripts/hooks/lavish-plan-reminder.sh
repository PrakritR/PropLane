#!/usr/bin/env bash
# UserPromptSubmit hook — keeps the captain's plan-first standing order in front
# of the agent on every prompt, and makes the Lavish poll unmissable while a
# plan is open.
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

if [ -f "$root/.lavish/active-session.json" ]; then
  msg="LAVISH PLAN OPEN. Run \`npm run lavish:poll\` as your FIRST command this turn, apply the captain's edits to the SAME plan.html, reply with \`npm run lavish:poll -- --reply \\\"...\\\"\`, and write NO product code until he says \`approved — build\` (then \`npm run lavish:poll -- --clear\`)."
else
  msg="PLAN FIRST: if this message describes work, scaffold a Lavish plan (\`npm run workflow:plan -- --chat \\\"<his message>\\\"\`), fill it — the UI tab must MOCK the screen, before/after + desktop/mobile — start \`npm run lavish:listen\`, and stop until \`approved — build\`. Do NOT file a Linear ticket for an issue unless he asks. Standard: docs/agents/lavish-plan-standard.md."
fi

printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"%s"}}\n' "$msg"
