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

BACKUP="live-application-fee-backup-$STAMP.json"
q "select id, property_data, updated_at from public.manager_property_records where id in ($IDS)" > "$BACKUP"
chmod 600 "$BACKUP"
echo "backup: $DIR/$BACKUP"

PLAN="select id, property_data->'listingSubmission'->>'applicationFee' as fee from public.manager_property_records where id in ($IDS) order by id"
BEFORE="live-application-fee-plan-$STAMP.json"
q "$PLAN" > "$BEFORE"
cat "$BEFORE"

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

python3 -I - "$BEFORE" "$UPDATED" "$VERIFY" "${IDS_ARR[@]}" <<'PY'
import json, sys

before_path, updated_path, verify_path, *expected = sys.argv[1:]

def rows(path):
    try:
        with open(path, encoding="utf-8") as fh:
            payload = json.load(fh)
    except (OSError, json.JSONDecodeError) as err:
        raise SystemExit(f"verify FAILED: could not read {path} as JSON ({err})")
    # The CLI wraps results as {"rows": [...]} when it detects an agent, and emits a bare array otherwise.
    if isinstance(payload, dict):
        payload = payload.get("rows")
    if not isinstance(payload, list):
        raise SystemExit(f"verify FAILED: {path} is not a JSON result set")
    return payload

def fees(path):
    out = {}
    for row in rows(path):
        if not isinstance(row, dict) or "id" not in row:
            raise SystemExit(f"verify FAILED: {path} has a row with no id")
        out[str(row["id"])] = None if row.get("fee") is None else str(row["fee"])
    return out

before = fees(before_path)
after = fees(verify_path)
updated = fees(updated_path)

missing = [i for i in expected if i not in before]
if missing:
    raise SystemExit(f"verify FAILED: the plan read no row for {missing}")

was_fifty = {i for i, fee in before.items() if fee == "50"}
if set(updated) != was_fifty:
    raise SystemExit(
        f"verify FAILED: the update returned {sorted(updated)} but {sorted(was_fifty)} read \"50\""
    )
wrong = {i: fee for i, fee in updated.items() if fee != "0"}
if wrong:
    raise SystemExit(f"verify FAILED: the update returned a row that is not \"0\": {wrong}")

missing_after = [i for i in expected if i not in after]
if missing_after:
    raise SystemExit(f"verify FAILED: the read-back found no row for {missing_after}")
still = {i: after[i] for i in expected if after[i] != "0"}
if still:
    raise SystemExit(f"verify FAILED: a live listing does not read \"0\": {still}")

print(f'verified: all {len(expected)} live listings read applicationFee "0" ({len(was_fifty)} updated)')
PY
