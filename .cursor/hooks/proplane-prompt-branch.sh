#!/usr/bin/env bash
# Create (sessionStart) or close-if-empty (sessionEnd) a PropPlane prompt branch.
# Noops when firstmate is not installed (other clones / Akhil machines).
set -eu
mode=${1:-start}
fm_home="${FM_HOME:-$HOME/firstmate}"
script="$fm_home/bin/fm-proplane-prompt-branch.sh"
[ -x "$script" ] || exit 0
if [ "$mode" = end ]; then
  exec "$script" hook-session-end
fi
exec "$script" hook-session-start
