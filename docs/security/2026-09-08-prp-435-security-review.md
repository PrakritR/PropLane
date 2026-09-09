# PRP-435 leasing facts security review

- Reviewed worktree: `/private/tmp/axis-prp-435-20260908`
- Base commit: `6f24d93b712f140d16af5f10e14b1fd88edd61aa`
- Reviewed diff SHA-256: `e009567b69f1e8cd7b08083ec00ddbf4dbad3074125d83bdf2cda295cf132b16`
- Review mode: read-only independent diff review

## Result

No security blocker found in the reviewed diff.

## Evidence

1. Public data remains allowlisted. `src/lib/public-listings.server.ts` adds only `securityDeposit` to `PUBLIC_ROOM_KEYS`. The projection still uses `pickRows`, so manager-only room fields such as move-in instructions are not exposed. Listing-wide deposits, utilities, terms, and fees were already explicitly public submission keys.
2. The leasing tool reads only live/listed owner rows or the existing `getPublicListings()` public projection. It does not add a service-role lookup around the projection or expose the raw listing submission in its result.
3. Missing pet policy remains nullable. The code reads a boolean only when the stored value is actually boolean and avoids the normalizer's false default.
4. Malformed submissions fail to unknown facts. Raw malformed values are not copied into the tool response. Normalized rooms are bounded by the existing listing schema and the details response returns selected fields only.
5. Deposit output is labeled as standard-lease data and preserves an explicit string `"0"` room override through nullish selection. The prompt prohibits applying it to short-term stays.
6. Payload and cache impact is bounded. The anonymous catalog gains one short scalar per room. `get_listing_details` adds selected facts for one resolved listing, while the existing 30-second catalog TTL and in-flight coalescing remain unchanged.
7. Leasing email shares `leasingSmsAgentRegistry` and resolves `LEASING_SMS_AGENT_SYSTEM_PROMPT` through `leasingSmsSystemPromptForWorkNumberOwner`, so the same fact and missing-data rules apply to email without a parallel data path.
8. The corrected surcharge shape is conditional and unassociated with a named lease term. It states that the value applies only when selected standard-lease dates form a non-standard calendar term, matching the canonical billing predicate.

## Residual risks

- The tool returns all room deposit and utility summaries even when `roomQuery` narrows the primary `rooms` array. This is still public listing data and creates no cross-listing disclosure, but it modestly increases model input for large listings.
- Real SMS and email behavior still requires authorized dev/test QA. No external message was sent during this review.
