# PRP-435 leasing facts bug review

- Reviewed worktree: `/private/tmp/axis-prp-435-20260908`
- Base commit: `6f24d93b712f140d16af5f10e14b1fd88edd61aa`
- Reviewed diff SHA-256: `e009567b69f1e8cd7b08083ec00ddbf4dbad3074125d83bdf2cda295cf132b16`
- Existing validation supplied by implementer: TypeScript with 4096 MB passed; 31 focused tests and targeted lint passed

## Resolved finding

### [P1] Do not claim `customLeaseSurcharge` for every Long-term lease - resolved

`src/lib/tools/domains/leasing-sms.ts` emits `customLeaseSurcharge` as `monthlySurcharge` for both `Long-term` and `Custom` term rows whenever those options are offered. The billing contract in `src/lib/custom-lease-billing.ts` is narrower: `shouldBillCustomLeaseSurcharge` requires `isCustomCalendarLease(leaseStart, leaseEnd)`. Existing coverage in `tests/unit/long-term-lease-parity.test.ts` likewise says the surcharge applies only when the term uses non-standard calendar dates.

This can make a prospect-facing SMS or email claim that an ordinary Long-term option costs an extra amount when it does not. The new prompt explicitly authorizes quoting returned term surcharges, so the misleading association is likely to reach the response.

Resolution evidence: the corrected tool removes `Long-term` and `Custom` rows from `termSurcharges`. It now returns one unassociated `customCalendarSurcharge` object with explicit eligibility and the statement that it applies only when selected standard-lease dates use a non-standard calendar term. The regression calls canonical `shouldBillCustomLeaseSurcharge`: aligned Long-term dates return false and non-standard dates return true. Focused leasing tests pass 26/26 and targeted lint passes.

## Resolved or adequately covered areas

- Base room prices are explicitly unassociated with lease terms, avoiding unsupported term-to-rate claims.
- Missing pet policy is `null`, not `false`.
- Malformed listing values resolve to empty or null facts instead of throwing or copying raw values.
- Standard deposit selection preserves an explicit room override of `"0"` and inherits the listing amount only for a missing room override.
- Standard deposits are not represented as short-term deposits.
- Shared leasing email uses the same registry and prompt as leasing SMS.
- Public payload growth is limited to one allowlisted room scalar; the richer details object is returned only for one resolved listing.

## Gate

No open bug-review blocker remains in this diff. Real-channel QA and the coordinator's normal gates remain outstanding.
