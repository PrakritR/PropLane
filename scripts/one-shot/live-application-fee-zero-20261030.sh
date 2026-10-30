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
set -euo pipefail

DIR="${1:?usage: $0 <linked-dir> [--apply]}"
APPLY="${2:-}"
IDS="'mgr-listing-1x3tiu0489ha','mgr-5257-brooklyn-ave-copy-9-rooms-7mbwr0uza0nq','mgr-5259-brooklyn-ave-copy-9-rooms-7mdlyj0h2vfg'"
STAMP="$(date +%Y%m%d-%H%M%S)"
cd "$DIR"

grep -q qahnczmilgptcedaqype supabase/.temp/project-ref 2>/dev/null || { echo "refusing: $DIR is not linked to production" >&2; exit 2; }

BACKUP="live-application-fee-backup-$STAMP.json"
supabase db query --linked "select id, property_data, updated_at from public.manager_property_records where id in ($IDS)" > "$BACKUP"
chmod 600 "$BACKUP"
echo "backup: $DIR/$BACKUP"

PLAN="select id, property_data->'listingSubmission'->>'applicationFee' as fee from public.manager_property_records where id in ($IDS) order by id"
supabase db query --linked "$PLAN"

if [ "$APPLY" != "--apply" ]; then
  echo "dry run only; pass --apply to set applicationFee to \"0\" on the rows above that read \"50\""
  exit 0
fi

supabase db query --linked "update public.manager_property_records
  set property_data = jsonb_set(property_data, '{listingSubmission,applicationFee}', '\"0\"'::jsonb, false),
      updated_at = now()
  where id in ($IDS)
    and property_data->'listingSubmission'->>'applicationFee' = '50'
  returning id, property_data->'listingSubmission'->>'applicationFee' as fee"

supabase db query --linked "$PLAN" | tee "live-application-fee-verify-$STAMP.json"
if supabase db query --linked "$PLAN" | grep -q '"fee": "50"'; then
  echo "verify FAILED: a row still reads 50" >&2
  exit 1
fi
echo "verified: all three live listings read applicationFee \"0\""
