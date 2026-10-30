#!/usr/bin/env bash
# One shot, captain waiver 2026-10-30 (.cursor/rules/no-production-live-listings.mdc): set the listing-level
# Application fee of the three live houses to $0. Writes ONLY property_data.listingSubmission.applicationFee, and
# only on a row whose value is still "50". Nothing else on the listing (rooms, pricing, photos, move-in) is touched.
#
#   bash scripts/one-shot/live-application-fee-zero-20261030.sh <linked-dir>            dry run: backup + plan
#   bash scripts/one-shot/live-application-fee-zero-20261030.sh <linked-dir> --apply    write, then read back
#
# <linked-dir> is a scratch directory where `supabase link --project-ref qahnczmilgptcedaqype` was run.
# Do not re-run after a successful apply.
#
# Every query asks the CLI for JSON (`--output-format json`, `supabase db query --help`) and the verification
# PARSES it. The CLI's default output is a drawn text table, so the earlier grep for '"fee": "50"' could never
# match and the script reported success without ever having read a row back.
#
# The SAME parser runs on the plan BEFORE the write, so an output shape this script cannot read (the CLI's
# Effect-style `{"_tag":"Error",...}` envelope, a future wrapper key, a text table) stops the run while nothing
# has been committed, instead of leaving the operator with an applied-but-unverified production write and a
# header telling them not to re-run.
set -euo pipefail

DIR="${1:?usage: $0 <linked-dir> [--apply]}"
APPLY="${2:-}"
IDS_ARR=(
  mgr-listing-1x3tiu0489ha
  mgr-5257-brooklyn-ave-copy-9-rooms-7mbwr0uza0nq
  mgr-5259-brooklyn-ave-copy-9-rooms-7mdlyj0h2vfg
)
IDS="$(printf "'%s'," "${IDS_ARR[@]}")"; IDS="${IDS%,}"
STAMP="$(date +%Y%m%d-%H%M%S)"
cd "$DIR"

grep -q qahnczmilgptcedaqype supabase/.temp/project-ref 2>/dev/null || { echo "refusing: $DIR is not linked to production" >&2; exit 2; }

q() { supabase db query --linked --output-format json "$1"; }

CHECK="$(cat <<'PY'
import json, sys

mode, *rest = sys.argv[1:]

def fail(message):
    raise SystemExit(f"one-shot FAILED: {message}")

def result_rows(path, label):
    """The CLI's result set: a bare array, or the agent-mode `{"rows": [...]}` wrapper. Anything else stops the
    run with the CLI's own words where it has them, because a shape we cannot read is not a row we have seen."""
    try:
        with open(path, encoding="utf-8") as fh:
            payload = json.load(fh)
    except (OSError, json.JSONDecodeError) as err:
        fail(f"the {label} output is not JSON ({err}); read it yourself at {path}")
    if isinstance(payload, dict):
        if payload.get("_tag") == "Error":
            err = payload.get("error")
            code = err.get("code") if isinstance(err, dict) else None
            message = err.get("message") if isinstance(err, dict) else err
            fail(f"the CLI refused the {label} query: {code or '?'}: {message or payload}")
        if "rows" not in payload:
            fail(
                f"the {label} output is a JSON object with no \"rows\"; this script only reads a bare array or "
                f"{{\"rows\": [...]}}. Keys: {sorted(payload)}. Read it yourself at {path}"
            )
        payload = payload.get("rows")
    if not isinstance(payload, list):
        fail(f"the {label} output is not a result set; read it yourself at {path}")
    return payload

def fees(path, label):
    out = {}
    for row in result_rows(path, label):
        if not isinstance(row, dict) or "id" not in row:
            fail(f"the {label} output has a row with no id; read it yourself at {path}")
        out[str(row["id"])] = None if row.get("fee") is None else str(row["fee"])
    return out

if mode == "plan":
    plan_path, *expected = rest
    before = fees(plan_path, "plan")
    missing = [i for i in expected if i not in before]
    if missing:
        fail(f"the plan read no row for {missing}")
    unexpected = {i: before[i] for i in expected if before[i] not in ("0", "50")}
    if unexpected:
        # The update only moves a "50", so a third value would commit a partial change and fail the read-back.
        fail(f'a live listing reads an application fee this waiver does not cover: {unexpected}')
    print(f'plan readable: {sum(1 for i in expected if before[i] == "50")} of {len(expected)} read "50"')
    raise SystemExit(0)

if mode != "apply":
    fail(f"unknown mode {mode!r}")

plan_path, updated_path, verify_path, *expected = rest
before = fees(plan_path, "plan")
updated = fees(updated_path, "update")
after = fees(verify_path, "read-back")

was_fifty = {i for i, fee in before.items() if fee == "50"}
if set(updated) != was_fifty:
    fail(f'the update returned {sorted(updated)} but {sorted(was_fifty)} read "50"')
wrong = {i: fee for i, fee in updated.items() if fee != "0"}
if wrong:
    fail(f'the update returned a row that is not "0": {wrong}')

missing_after = [i for i in expected if i not in after]
if missing_after:
    fail(f"the read-back found no row for {missing_after}")
still = {i: after[i] for i in expected if after[i] != "0"}
if still:
    fail(f'a live listing does not read "0": {still}')

print(f'verified: all {len(expected)} live listings read applicationFee "0" ({len(was_fifty)} updated)')
PY
)"

check() { printf '%s' "$CHECK" | python3 -I - "$@"; }

BACKUP="live-application-fee-backup-$STAMP.json"
q "select id, property_data, updated_at from public.manager_property_records where id in ($IDS)" > "$BACKUP"
chmod 600 "$BACKUP"
echo "backup: $DIR/$BACKUP"

PLAN="select id, property_data->'listingSubmission'->>'applicationFee' as fee from public.manager_property_records where id in ($IDS) order by id"
BEFORE="live-application-fee-plan-$STAMP.json"
q "$PLAN" > "$BEFORE"
cat "$BEFORE"
check plan "$BEFORE" "${IDS_ARR[@]}"

if [ "$APPLY" != "--apply" ]; then
  echo "dry run only; pass --apply to set applicationFee to \"0\" on the rows above that read \"50\""
  exit 0
fi

UPDATED="live-application-fee-updated-$STAMP.json"
q "update public.manager_property_records
  set property_data = jsonb_set(property_data, '{listingSubmission,applicationFee}', '\"0\"'::jsonb, false),
      updated_at = now()
  where id in ($IDS)
    and property_data->'listingSubmission'->>'applicationFee' = '50'
  returning id, property_data->'listingSubmission'->>'applicationFee' as fee" > "$UPDATED"
cat "$UPDATED"

VERIFY="live-application-fee-verify-$STAMP.json"
q "$PLAN" > "$VERIFY"
cat "$VERIFY"

check apply "$BEFORE" "$UPDATED" "$VERIFY" "${IDS_ARR[@]}"
